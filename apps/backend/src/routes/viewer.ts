/**
 * Viewer identity (§4.3 step 7, §6.5).
 * SECURITY-GATE SG-09: Telegram initData is validated (HMAC with the WebAppData-derived key) with a freshness window, and its user must be the token's contact.
 * SECURITY-GATE SG-12: email links are inert on GET (the static page makes no call); only a POST with the contact's PIN consumes anything.
 */
import { createHmac } from 'node:crypto';
import { type Channel, isValidTimestamp } from '@survey-anything/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getContact, getEvent, notify } from '../alerts/dispatcher';
import { enqueueMany, kick, type Senders } from '../alerts/outbox';
import { appendAudit } from '../actions/audit';
import type { AppCtx } from '../context';
import { safeEqual, tokenHash } from '../security/hmac';
import { checkPin, hashPin, PIN_RE } from '../security/pin';
import { RateLimiter } from '../security/rate-limit';
import { bindViewerSession, lookupToken, type StreamRow } from '../stream/tokens';
import { clientIp } from './common';

export type InitDataCheck = { ok: true; userId: string; authDate: number } | { ok: false; reason: string };

export function validateInitData(initData: string, botToken: string, maxAgeSec: number, nowMs: number): InitDataCheck {
  if (typeof initData !== 'string' || initData.length === 0 || initData.length > 4096) return { ok: false, reason: 'missing initData' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'missing hash' };
  const dataCheck = [...params.entries()]
    .filter(([k]) => k !== 'hash')
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (!safeEqual(calc, hash)) return { ok: false, reason: 'bad signature' };
  const authDate = Number(params.get('auth_date'));
  const now = Math.floor(nowMs / 1000);
  if (!Number.isInteger(authDate) || authDate > now + 60 || now - authDate > maxAgeSec) return { ok: false, reason: 'stale initData' };
  let userId: string | null = null;
  try {
    const u = JSON.parse(params.get('user') ?? 'null') as { id?: unknown } | null;
    if (u && (typeof u.id === 'number' || typeof u.id === 'string')) userId = String(u.id);
  } catch {
    userId = null;
  }
  if (!userId) return { ok: false, reason: 'no user' };
  return { ok: true, userId, authDate };
}

const Session = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const Tok = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const TelegramBody = z.object({ token: Tok, sessionId: Session, initData: z.string().max(4096) }).strict();
const EmailBody = z.object({ token: Tok, sessionId: Session, pin: z.string().max(32) }).strict();
const ReportBody = z.object({ playToken: Tok, candidateType: z.enum(['udp', 'tcp', 'relay', 'none']).nullable(), failed: z.boolean() }).strict();
const AckBody = z.object({ token: Tok, pin: z.string().max(32) }).strict();
const PinSetupBody = z.object({ token: Tok, pin: z.string().max(32) }).strict();


function playSources(ctx: AppCtx, playToken: string): { webrtc: string; llhls: string | null } {
  const sig = (ctx.env.OME_SIGNALING_BASE ?? '').replace(/\/+$/, '').replace(/^http/, 'ws');
  const hls = ctx.env.OME_LLHLS_BASE ? `${ctx.env.OME_LLHLS_BASE.replace(/\/+$/, '')}/${ctx.env.OME_APP}/${playToken}/llhls.m3u8` : null;
  return { webrtc: `${sig}/${ctx.env.OME_APP}/${playToken}?transport=all`, llhls: hls };
}

function grantResponse(ctx: AppCtx, stream: StreamRow, playToken: string) {
  const ev = stream.event_id ? getEvent(ctx, stream.event_id) : undefined;
  return {
    ok: true,
    meta: ev && isValidTimestamp(ev.ts) ? { eventId: ev.id, rule: ev.rule, severity: ev.severity, timestamp: ev.ts, title: ev.rule_title } : null,
    live: stream.live_at !== null,
    // OME creates the playable output only at the first keyframe, shortly after ingest is admitted,
    // so the viewer waits out what is left of the 5 s start budget (M5, found against the real OME).
    liveForMs: stream.live_at !== null ? Math.max(0, ctx.now() - stream.live_at) : null,
    expiresAt: new Date(stream.expires_at).toISOString(),
    sources: playSources(ctx, playToken),
    playToken,
  };
}

async function deny(reply: FastifyReply, code: number, reason: string): Promise<FastifyReply> {
  return reply.code(code).send({ ok: false, reason });
}

export function registerViewerRoutes(app: FastifyInstance, ctx: AppCtx, senders: Senders): void {
  const perIp = new RateLimiter(60, 60_000, ctx.now);
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/viewer/') || req.url.startsWith('/api/ack/') || req.url.startsWith('/api/pin/')) {
      if (!perIp.take(clientIp(req))) await reply.code(429).send({ ok: false, reason: 'rate limited' });
    }
  });

  app.post('/api/viewer/telegram', async (req, reply) => {
    const b = TelegramBody.safeParse(req.body);
    if (!b.success) return deny(reply, 400, 'invalid request');
    if (!ctx.env.TELEGRAM_BOT_TOKEN) return deny(reply, 503, 'telegram not configured');
    const l = lookupToken(ctx.db, b.data.token, ctx.now());
    if (!l.ok || l.token.role !== 'viewer' || l.token.channel !== 'telegram' || !l.token.contact_id) return deny(reply, 403, l.ok ? 'wrong token type' : l.reason);
    const v = validateInitData(b.data.initData, ctx.env.TELEGRAM_BOT_TOKEN, ctx.env.INITDATA_MAX_AGE_SEC, ctx.now());
    if (!v.ok) return deny(reply, 403, v.reason);
    const contact = getContact(ctx, l.token.contact_id);
    if (!contact?.telegram_user_id || contact.telegram_user_id !== v.userId) {
      appendAudit(ctx.db, 'viewer.denied', { reason: 'telegram identity mismatch', contactId: l.token.contact_id });
      return deny(reply, 403, 'this link belongs to someone else');
    }
    const bound = bindViewerSession(ctx.db, b.data.token, b.data.sessionId, ctx.now());
    if (!bound.ok) return deny(reply, 403, bound.reason);
    return grantResponse(ctx, bound.stream, bound.playToken);
  });

  app.post('/api/viewer/email', async (req, reply) => {
    const b = EmailBody.safeParse(req.body);
    if (!b.success) return deny(reply, 400, 'invalid request');
    const l = lookupToken(ctx.db, b.data.token, ctx.now());
    if (!l.ok || l.token.role !== 'viewer' || l.token.channel !== 'email' || !l.token.contact_id) return deny(reply, 403, l.ok ? 'wrong token type' : l.reason);
    const pin = checkPin(ctx.db, l.token.contact_id, b.data.pin, ctx.now());
    if (pin.result === 'malformed') return deny(reply, 400, 'PIN must be 6 to 8 digits');
    if (pin.result === 'locked') return deny(reply, 423, `too many attempts; try again after ${new Date(pin.until).toISOString()}`);
    if (pin.result === 'no-pin') return deny(reply, 403, 'no PIN set for this contact; ask the owner to re-pair you');
    if (pin.result === 'wrong') {
      appendAudit(ctx.db, 'pin.failed', { contactId: l.token.contact_id, failuresLastHour: pin.failuresLastHour });
      if (pin.alertOwner) await notify(ctx, senders, ['owner'], `pinabuse:${l.token.contact_id}:${ctx.now()}`, 'Repeated wrong PINs', `3 wrong PINs in an hour for contact "${l.token.contact_id}".`);
      return deny(reply, 403, 'wrong PIN');
    }
    const bound = bindViewerSession(ctx.db, b.data.token, b.data.sessionId, ctx.now());
    if (!bound.ok) return deny(reply, 403, bound.reason);
    return grantResponse(ctx, bound.stream, bound.playToken);
  });

  /** The viewer reports its selected candidate type (never an IP) or that its ladder is exhausted (§10). */
  app.post('/api/viewer/report', async (req, reply) => {
    const b = ReportBody.safeParse(req.body);
    if (!b.success) return deny(reply, 400, 'invalid request');
    const t = ctx.db.prepare("SELECT * FROM stream_tokens WHERE token_hash = ? AND role = 'play' AND revoked = 0").get(tokenHash(b.data.playToken)) as
      | { stream_id: string; contact_id: string | null }
      | undefined;
    if (!t?.contact_id) return deny(reply, 403, 'unknown session');
    ctx.db.prepare("INSERT INTO probe_reports(at, stream_id, side, candidate_type) VALUES (?, ?, 'viewer', ?)").run(ctx.now(), t.stream_id, b.data.candidateType ?? 'none');
    if (b.data.failed) {
      const s = ctx.db.prepare('SELECT event_id FROM streams WHERE id = ?').get(t.stream_id) as { event_id: string | null } | undefined;
      const ev = s?.event_id ? getEvent(ctx, s.event_id) : undefined;
      if (ev) {
        const rows = (JSON.parse(ev.channels) as Channel[]).map((channel) => ({
          key: `${ev.id}:${t.contact_id}:${channel}:clip`,
          eventId: ev.id,
          contactId: t.contact_id as string,
          channel,
          kind: 'clip' as const,
          payload: { eventId: ev.id, contactId: t.contact_id as string },
        }));
        void kick(ctx, senders, enqueueMany(ctx, rows));
        return { ok: true, clip: ev.clip_path ? 'sending' : 'will send when uploaded' };
      }
    }
    return { ok: true };
  });

  app.post('/api/ack/email', async (req, reply) => {
    const b = AckBody.safeParse(req.body);
    if (!b.success) return deny(reply, 400, 'invalid request');
    const now = ctx.now();
    const row = ctx.db.prepare('SELECT event_id, contact_id, expires_at, used_at FROM ack_tokens WHERE token_hash = ?').get(tokenHash(b.data.token)) as
      | { event_id: string; contact_id: string; expires_at: number; used_at: number | null }
      | undefined;
    if (!row || row.expires_at <= now) return deny(reply, 403, 'link invalid or expired');
    const pin = checkPin(ctx.db, row.contact_id, b.data.pin, now);
    if (pin.result === 'malformed') return deny(reply, 400, 'PIN must be 6 to 8 digits');
    if (pin.result === 'locked') return deny(reply, 423, 'too many attempts');
    if (pin.result !== 'ok') return deny(reply, 403, pin.result === 'no-pin' ? 'no PIN set' : 'wrong PIN');
    ctx.db.prepare('UPDATE ack_tokens SET used_at = COALESCE(used_at, ?) WHERE token_hash = ?').run(now, tokenHash(b.data.token));
    const r = ctx.db.prepare("UPDATE events SET acked_at = ?, acked_by = ?, ack_channel = 'email' WHERE id = ? AND acked_at IS NULL").run(now, row.contact_id, row.event_id);
    appendAudit(ctx.db, 'event.ack', { eventId: row.event_id, by: row.contact_id, channel: 'email', first: r.changes === 1 }, now);
    return { ok: true, acknowledged: true, first: r.changes === 1 };
  });

  /** One-time PIN choice. A PIN can never be changed in place; reset means re-pairing (§6.5). */
  app.post('/api/pin/setup', async (req, reply) => {
    const b = PinSetupBody.safeParse(req.body);
    if (!b.success) return deny(reply, 400, 'invalid request');
    if (!PIN_RE.test(b.data.pin)) return deny(reply, 400, 'PIN must be 6 to 8 digits');
    const now = ctx.now();
    const inv = ctx.db.prepare("SELECT contact_id FROM contact_invites WHERE token_hash = ? AND kind = 'pin' AND used_at IS NULL AND expires_at > ?").get(tokenHash(b.data.token), now) as
      | { contact_id: string }
      | undefined;
    if (!inv) return deny(reply, 403, 'link invalid, expired or already used');
    const set = ctx.db.prepare('UPDATE contacts SET pin_hash = ? WHERE id = ? AND pin_hash IS NULL').run(hashPin(b.data.pin), inv.contact_id);
    if (set.changes !== 1) return deny(reply, 409, 'a PIN is already set; ask the owner to re-pair you');
    ctx.db.prepare('UPDATE contact_invites SET used_at = ? WHERE token_hash = ?').run(now, tokenHash(b.data.token));
    appendAudit(ctx.db, 'pin.set', { contactId: inv.contact_id }, now);
    return { ok: true };
  });
}

// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Device pairing (C17, SG-16) and contact pairing (C18, §6.5).
 */
import { ContactInviteRequestSchema, type ContactStatus, newId22, PairDeviceRequestSchema } from '@survey-anything/shared';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getContact, notify, type ContactRow } from '../alerts/dispatcher';
import { enqueueMany, kick, type Senders } from '../alerts/outbox';
import { appendAudit } from '../actions/audit';
import type { AppCtx } from '../context';
import { features } from '../config';
import { pairingCode, sha256Hex, token256, tokenHash } from '../security/hmac';
import { RateLimiter } from '../security/rate-limit';
import { clientIp, requireDevice } from './common';

export const PAIRING_TTL_MS = 10 * 60_000;

/** Owner side (CLI): a one-time 8-character code valid for 10 minutes. */
export function createPairingCode(ctx: AppCtx): string {
  const code = pairingCode();
  ctx.db.prepare('INSERT INTO pairing_codes(code_hash, expires_at) VALUES (?, ?)').run(sha256Hex(`pair:${code}`), ctx.now() + PAIRING_TTL_MS);
  return code;
}

export function capabilitiesFor(ctx: AppCtx) {
  const f = features(ctx.env);
  return { ...f, publicBaseUrl: ctx.env.PUBLIC_BASE_URL, sourceUrl: ctx.env.SOURCE_URL };
}

function contactStatus(c: ContactRow): ContactStatus {
  return {
    contactId: c.id,
    roles: JSON.parse(c.roles) as string[],
    telegramPaired: c.telegram_chat_id !== null,
    emailSet: c.email !== null,
    pinSet: c.pin_hash !== null,
    lastTestOk: {
      telegram: c.last_test_telegram ? new Date(c.last_test_telegram).toISOString() : null,
      email: c.last_test_email ? new Date(c.last_test_email).toISOString() : null,
    },
  };
}

function invite(ctx: AppCtx, contactId: string, kind: 'telegram' | 'pin'): string {
  const token = kind === 'telegram' ? newId22() : token256();
  ctx.db.prepare('INSERT INTO contact_invites(token_hash, contact_id, kind, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash(token), contactId, kind, ctx.now() + 7 * 24 * 3_600_000);
  return token;
}

export function pinSetupLink(ctx: AppCtx, contactId: string): string {
  return `${ctx.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/v/pin.html?t=${invite(ctx, contactId, 'pin')}`;
}

export function registerPairingRoutes(app: FastifyInstance, ctx: AppCtx, senders: Senders): void {
  const pairPerIp = new RateLimiter(5, 10 * 60_000, ctx.now);
  const pairGlobal = new RateLimiter(30, 10 * 60_000, ctx.now);
  app.post('/api/pair/device', async (req, reply) => {
    if (!pairPerIp.take(clientIp(req)) || !pairGlobal.take('all')) return reply.code(429).header('retry-after', '600').send({ error: 'too many pairing attempts' });
    const body = PairDeviceRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid request' });
    const now = ctx.now();
    const hash = sha256Hex(`pair:${body.data.code}`);
    const claimed = ctx.db.prepare('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?').run(now, hash, now);
    if (claimed.changes !== 1) return reply.code(403).send({ error: 'invalid or expired code' });
    const deviceId = `dev_${randomUUID().slice(0, 8)}`;
    const token = token256();
    ctx.db.prepare('INSERT INTO devices(id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').run(deviceId, body.data.name, tokenHash(token), now);
    appendAudit(ctx.db, 'device.paired', { deviceId, name: body.data.name }, now);
    return { deviceId, deviceToken: token, capabilities: capabilitiesFor(ctx) };
  });

  const auth = requireDevice(ctx);

  app.get('/api/capabilities', { preHandler: auth }, async () => capabilitiesFor(ctx));

  app.get('/api/contacts', { preHandler: auth }, async () => {
    const rows = ctx.db.prepare('SELECT * FROM contacts ORDER BY id').all() as unknown as ContactRow[];
    return rows.map(contactStatus);
  });

  /**
   * Invites a contact. If the contact already paired, this is a re-pair: identity and PIN are
   * cleared, and the contact and the owner are notified on every configured channel (§6.5).
   * There is no route that changes a PIN in place.
   */
  app.post('/api/contacts', { preHandler: auth }, async (req, reply) => {
    const body = ContactInviteRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid request', issues: body.error.issues.map((i) => i.message) });
    const { contactId, roles, email, channels } = body.data;
    const existing = getContact(ctx, contactId);
    const now = ctx.now();
    if (existing && (existing.telegram_chat_id || existing.pin_hash || existing.email)) {
      const notifyIds = contactId === 'owner' ? ['owner'] : [contactId, 'owner'];
      await notify(ctx, senders, notifyIds, `repair:${contactId}:${now}`, 'Survey Anything: contact re-paired', `Contact "${contactId}" is being re-paired. Their Telegram link and PIN were reset by device ${req.device?.id ?? '?'}. If you did not expect this, check the backend.`);
      ctx.db.prepare('UPDATE contacts SET telegram_user_id = NULL, telegram_chat_id = NULL, pin_hash = NULL, paired_at = NULL WHERE id = ?').run(contactId);
      ctx.db.prepare('UPDATE contact_invites SET used_at = ? WHERE contact_id = ? AND used_at IS NULL').run(now, contactId);
      appendAudit(ctx.db, 'contact.repair', { contactId, by: req.device?.id }, now);
    }
    ctx.db
      .prepare(
        'INSERT INTO contacts(id, roles, channels, email, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET roles = excluded.roles, channels = excluded.channels, email = excluded.email',
      )
      .run(contactId, JSON.stringify(roles), JSON.stringify(channels), email, now);
    const tg = ctx.telegram && ctx.env.TELEGRAM_BOT_USERNAME ? `https://t.me/${ctx.env.TELEGRAM_BOT_USERNAME}?start=${invite(ctx, contactId, 'telegram')}` : null;
    return { telegramLink: tg, pinSetupLink: pinSetupLink(ctx, contactId) };
  });

  app.post<{ Params: { id: string } }>('/api/contacts/:id/test', { preHandler: auth }, async (req, reply) => {
    const c = getContact(ctx, req.params.id);
    if (!c) return reply.code(404).send({ error: 'unknown contact' });
    const now = ctx.now();
    const rows = (['telegram', 'email'] as const)
      .filter((ch) => (ch === 'telegram' ? c.telegram_chat_id : c.email))
      .map((ch) => ({
        key: `test:${c.id}:${ch}:${now}`,
        eventId: null,
        contactId: c.id,
        channel: ch,
        kind: 'test' as const,
        payload: { contactId: c.id, title: 'Survey Anything test alert', text: 'If you can read this, alerts reach you on this channel. Check your spam folder rules too.' },
      }));
    const keys = enqueueMany(ctx, rows);
    const outcomes = await kick(ctx, senders, keys);
    const out: Record<string, { ok: boolean; error: string | null }> = {};
    rows.forEach((r, i) => {
      const err = (ctx.db.prepare('SELECT last_error FROM outbox WHERE key = ?').get(r.key) as { last_error: string | null } | undefined)?.last_error ?? null;
      out[r.channel] = { ok: outcomes[i] === 'sent', error: outcomes[i] === 'sent' ? null : err };
    });
    if (!c.telegram_chat_id) out['telegram'] = { ok: false, error: 'Telegram not paired' };
    if (!c.email) out['email'] = { ok: false, error: 'no email address' };
    return out;
  });
}

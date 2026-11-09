/**
 * OME AdmissionWebhooks handler (§6.5, S11) and the Caddy forward_auth check.
 * SECURITY-GATE SG-11: signature verified, unknown means deny, the event's recipient allowlist is enforced before any viewer is admitted, and forward_auth refuses untokened signaling before OME sees it.
 */
import type { Db } from '../db/migrate';
import { hmacSha1Base64Url, safeEqual } from '../security/hmac';
import { lookupToken, rewriteStreamName, tokenFromOmeUrl } from './tokens';

export interface AdmissionRequest {
  client?: { address?: string; port?: number; real_ip?: string; user_agent?: string };
  request?: { direction?: string; protocol?: string; status?: string; url?: string; new_url?: string; time?: string };
}

export type AdmissionResponse = { allowed: boolean; new_url?: string; lifetime?: number; reason?: string } | Record<string, never>;

export function verifyOmeSignature(secret: string, rawBody: Buffer | string, header: string | undefined): boolean {
  if (!header) return false;
  return safeEqual(hmacSha1Base64Url(secret, rawBody), header.trim());
}

const deny = (reason: string): AdmissionResponse => ({ allowed: false, reason });

export function decideAdmission(db: Db, app: string, body: AdmissionRequest, now = Date.now()): AdmissionResponse {
  const raw = body.request;
  if (!raw || typeof raw.url !== 'string') return deny('malformed request');
  // OME v0.21.0 sends e.g. "WebRTC" and "LLHLS" although the docs show lowercase (checked against the pinned image, M5).
  const req = {
    ...raw,
    url: raw.url,
    direction: raw.direction?.toLowerCase(),
    protocol: raw.protocol?.toLowerCase(),
    status: raw.status?.toLowerCase(),
  };
  if (req.status === 'closing') {
    if (req.direction === 'incoming') {
      const token = tokenFromOmeUrl(req.url, app);
      const l = token ? lookupToken(db, token, now) : null;
      if (l?.ok) db.prepare('UPDATE streams SET ended_at = COALESCE(ended_at, ?) WHERE id = ? AND probe = 1').run(now, l.stream.id);
    }
    return {};
  }
  if (req.status !== 'opening') return deny('unknown status');
  const token = tokenFromOmeUrl(req.url, app);
  if (!token) return deny('no token in URL');
  const l = lookupToken(db, token, now);
  if (!l.ok) return deny(l.reason);
  const lifetime = Math.max(1, l.stream.expires_at - now);

  if (req.direction === 'incoming') {
    if (l.token.role !== 'publisher' && l.token.role !== 'probe') return deny('token cannot publish');
    if (req.protocol !== 'webrtc') return deny('only WebRTC/WHIP ingest is accepted');
    db.prepare('UPDATE streams SET live_at = COALESCE(live_at, ?) WHERE id = ?').run(now, l.stream.id);
    return { allowed: true, new_url: rewriteStreamName(req.url, app, l.stream.id), lifetime };
  }
  if (req.direction === 'outgoing') {
    if (l.token.role !== 'play') return deny('token cannot play');
    if (req.protocol !== 'webrtc' && req.protocol !== 'llhls') return deny('protocol not offered');
    // Allowlist: the play token's contact must be a recipient of this stream's event.
    const ev = l.stream.event_id ? (db.prepare('SELECT recipients FROM events WHERE id = ?').get(l.stream.event_id) as { recipients: string } | undefined) : undefined;
    const recipients = ev ? (JSON.parse(ev.recipients) as string[]) : [];
    if (!l.token.contact_id || !recipients.includes(l.token.contact_id)) return deny('viewer is not on this event\'s allowlist');
    return { allowed: true, new_url: rewriteStreamName(req.url, app, l.stream.id), lifetime };
  }
  return deny('unknown direction');
}

/**
 * Caddy forward_auth: every request on the OME signaling route must carry a live token. The only
 * exception (an LL-HLS playlist or part GET/HEAD without Upgrade) is decided in the Caddyfile and
 * still goes through admission.
 */
/**
 * LL-HLS after admission: OME's master playlist points its chunklists, parts and segments at the internal
 * stream name (/app/<stream id>/...), which carries no token, and OME does not check its own session id in
 * those file names. So the viewer adds its play token as `sa=` to every LL-HLS request (apps/viewer), and a
 * media file under a stream id is allowed only with a live play token for that same stream. The master
 * playlist by stream id is never allowed: it must be opened with the token path, through admission.
 */
const LLHLS_MEDIA = /^\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(chunklist|part|seg|init)_[A-Za-z0-9_.-]+\.(m3u8|m4s)$/;

function decideLlhlsMedia(db: Db, app: string, u: URL, now: number): { ok: boolean; reason: string } | null {
  const m = LLHLS_MEDIA.exec(u.pathname);
  if (!m || !u.pathname.startsWith(`/${app}/`)) return null;
  const play = u.searchParams.get('sa');
  if (!play) return { ok: false, reason: 'LL-HLS media without a play token' };
  const l = lookupToken(db, play, now);
  if (!l.ok) return { ok: false, reason: l.reason };
  if (l.token.role !== 'play') return { ok: false, reason: 'not a play token' };
  if (l.token.stream_id !== m[1]) return { ok: false, reason: 'play token is for another stream' };
  return { ok: true, reason: 'ok' };
}

export function decideForwardAuth(db: Db, app: string, forwardedUri: string | undefined, now = Date.now()): { ok: boolean; reason: string } {
  if (!forwardedUri) return { ok: false, reason: 'no X-Forwarded-Uri' };
  let token: string | null;
  try {
    const u = new URL(forwardedUri, 'https://placeholder.invalid');
    const media = decideLlhlsMedia(db, app, u, now);
    if (media) return media;
    token = tokenFromOmeUrl(u.href, app);
  } catch {
    return { ok: false, reason: 'bad URI' };
  }
  if (!token) return { ok: false, reason: 'no token' };
  const l = lookupToken(db, token, now);
  if (!l.ok) return { ok: false, reason: l.reason };
  if (!['publisher', 'probe', 'play'].includes(l.token.role)) return { ok: false, reason: 'token not valid for signaling' };
  return { ok: true, reason: 'ok' };
}

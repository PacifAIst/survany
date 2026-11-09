// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stream identity (§6.5).
 * SECURITY-GATE SG-10: stream tokens are 256-bit, live at most 10 minutes, are stored only as SHA-256, and a viewer token binds to the first valid session; only that session may reconnect.
 */
import { randomUUID } from 'node:crypto';
import { STREAM_TTL_MAX_MINUTES } from '@survey-anything/shared';
import type { Db } from '../db/migrate';
import { token256, tokenHash } from '../security/hmac';

export type TokenRole = 'publisher' | 'viewer' | 'play' | 'probe';

export interface StreamRow {
  id: string;
  event_id: string | null;
  device_id: string;
  created_at: number;
  expires_at: number;
  live_at: number | null;
  ended_at: number | null;
  probe: number;
}

export interface TokenRow {
  token_hash: string;
  stream_id: string;
  role: TokenRole;
  contact_id: string | null;
  channel: string | null;
  expires_at: number;
  session_hash: string | null;
  parent_hash: string | null;
  revoked: number;
}

const MAX_TTL_MS = STREAM_TTL_MAX_MINUTES * 60_000;

export function createStream(db: Db, deviceId: string, eventId: string | null, ttlMinutes: number, now = Date.now(), probe = false, ttlMsOverride?: number): StreamRow {
  const ttl = ttlMsOverride ?? Math.min(Math.max(1, ttlMinutes) * 60_000, MAX_TTL_MS);
  const row: StreamRow = { id: randomUUID(), event_id: eventId, device_id: deviceId, created_at: now, expires_at: now + Math.min(ttl, MAX_TTL_MS), live_at: null, ended_at: null, probe: probe ? 1 : 0 };
  db.prepare('INSERT INTO streams(id, event_id, device_id, created_at, expires_at, probe) VALUES (?, ?, ?, ?, ?, ?)').run(row.id, eventId, deviceId, now, row.expires_at, row.probe);
  return row;
}

export function mintToken(db: Db, stream: StreamRow, role: TokenRole, opts: { contactId?: string; channel?: string; parentHash?: string; sessionHash?: string; now?: number } = {}): string {
  const token = token256();
  const now = opts.now ?? Date.now();
  db.prepare(
    'INSERT INTO stream_tokens(token_hash, stream_id, role, contact_id, channel, expires_at, session_hash, parent_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(tokenHash(token), stream.id, role, opts.contactId ?? null, opts.channel ?? null, stream.expires_at, opts.sessionHash ?? null, opts.parentHash ?? null, now);
  return token;
}

export type TokenLookup = { ok: true; token: TokenRow; stream: StreamRow } | { ok: false; reason: string };

export function lookupToken(db: Db, token: string, now = Date.now()): TokenLookup {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, reason: 'malformed token' };
  const t = db.prepare('SELECT * FROM stream_tokens WHERE token_hash = ?').get(tokenHash(token)) as TokenRow | undefined;
  if (!t) return { ok: false, reason: 'unknown token' };
  if (t.revoked) return { ok: false, reason: 'revoked' };
  if (t.expires_at <= now) return { ok: false, reason: 'expired' };
  const s = db.prepare('SELECT * FROM streams WHERE id = ?').get(t.stream_id) as StreamRow | undefined;
  if (!s) return { ok: false, reason: 'unknown stream' };
  if (s.ended_at !== null) return { ok: false, reason: 'stream ended' };
  if (s.expires_at <= now) return { ok: false, reason: 'stream expired' };
  return { ok: true, token: t, stream: s };
}

/**
 * Binds a viewer token to a session on first use. The same session may come back (reconnect,
 * or its LL-HLS fallback); any other session is refused. Returns the session's play token.
 */
export function bindViewerSession(db: Db, viewerToken: string, sessionId: string, now = Date.now()): { ok: true; playToken: string; stream: StreamRow; contactId: string | null } | { ok: false; reason: string } {
  const l = lookupToken(db, viewerToken, now);
  if (!l.ok) return l;
  if (l.token.role !== 'viewer') return { ok: false, reason: 'not a viewer token' };
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(sessionId)) return { ok: false, reason: 'malformed session' };
  const sh = tokenHash(`session:${sessionId}`);
  if (l.token.session_hash && l.token.session_hash !== sh) return { ok: false, reason: 'link already used by another session' };
  if (!l.token.session_hash) {
    const r = db.prepare('UPDATE stream_tokens SET session_hash = ? WHERE token_hash = ? AND session_hash IS NULL').run(sh, l.token.token_hash);
    if (r.changes !== 1) return { ok: false, reason: 'link already used by another session' };
  }
  // One play token per bound session: revoke earlier ones so a leaked play URL dies on reconnect.
  db.prepare("UPDATE stream_tokens SET revoked = 1 WHERE parent_hash = ? AND role = 'play'").run(l.token.token_hash);
  const playToken = mintToken(db, l.stream, 'play', { parentHash: l.token.token_hash, sessionHash: sh, ...(l.token.contact_id ? { contactId: l.token.contact_id } : {}), ...(l.token.channel ? { channel: l.token.channel } : {}), now });
  return { ok: true, playToken, stream: l.stream, contactId: l.token.contact_id };
}

export function endStream(db: Db, streamId: string, now = Date.now()): void {
  db.prepare('UPDATE streams SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(now, streamId);
  db.prepare('UPDATE stream_tokens SET revoked = 1 WHERE stream_id = ?').run(streamId);
}

/** Extracts the opaque token from an OME URL path `/<app>/<token>[/...]`. */
export function tokenFromOmeUrl(url: string, app: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] !== app || !parts[1]) return null;
    return decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
}

/** new_url changes only the stream name and keeps everything else, including the query (transport=all). */
export function rewriteStreamName(url: string, app: string, streamId: string): string {
  const u = new URL(url);
  const parts = u.pathname.split('/');
  const appIdx = parts.indexOf(app);
  if (appIdx < 0 || parts[appIdx + 1] === undefined) throw new Error('URL has no stream segment');
  parts[appIdx + 1] = streamId;
  u.pathname = parts.join('/');
  return u.href;
}

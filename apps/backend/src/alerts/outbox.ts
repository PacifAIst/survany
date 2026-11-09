/**
 * Durable outbox (§4.3, §10). One row per event + contact + channel (+ kind), so retries never
 * duplicate. Each channel retries on its own schedule; none waits for another.
 */
import type { Channel } from '@survey-anything/shared';
import type { AppCtx } from '../context';
import { tx } from '../db/migrate';
import { MailError } from './email';
import { TelegramError } from './telegram';

export type OutboxKind = 'alert' | 'clip' | 'notice' | 'test';

export interface OutboxPayload {
  eventId?: string;
  contactId: string;
  stage?: number;
  title?: string;
  text?: string;
}

export interface OutboxRowInput {
  key: string;
  eventId: string | null;
  contactId: string;
  channel: Channel;
  kind: OutboxKind;
  payload: OutboxPayload;
}

export interface OutboxRow {
  key: string;
  event_id: string | null;
  contact_id: string | null;
  channel: Channel;
  kind: OutboxKind;
  payload: string;
  attempts: number;
  next_at: number;
  status: 'pending' | 'sending' | 'sent' | 'failed';
  last_error: string | null;
  created_at: number;
  started_at: number | null;
  sent_at: number | null;
}

export class PermanentSendError extends Error {}

export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function backoffMs(attempts: number, retryAfterSec: number | null): number {
  if (retryAfterSec !== null && retryAfterSec > 0) return retryAfterSec * 1000;
  return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 10 * 60_000);
}

export function enqueueMany(ctx: AppCtx, rows: OutboxRowInput[]): string[] {
  const now = ctx.now();
  const inserted: string[] = [];
  tx(ctx.db, () => {
    const stmt = ctx.db.prepare(
      'INSERT OR IGNORE INTO outbox(key, event_id, contact_id, channel, kind, payload, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of rows) {
      const res = stmt.run(r.key, r.eventId, r.contactId, r.channel, r.kind, JSON.stringify(r.payload), now, now);
      if (res.changes === 1) inserted.push(r.key);
    }
  });
  return inserted;
}

export type ChannelSender = (row: OutboxRow, payload: OutboxPayload) => Promise<string | null>;

export interface Senders {
  telegram: ChannelSender;
  email: ChannelSender;
}

export type SendOutcome = 'sent' | 'retry' | 'failed' | 'skipped';

/** Claims one row atomically and sends it. Safe to call concurrently for different keys. */
export async function sendKey(ctx: AppCtx, senders: Senders, key: string): Promise<SendOutcome> {
  const now = ctx.now();
  const claim = ctx.db
    .prepare("UPDATE outbox SET status = 'sending', started_at = ?, attempts = attempts + 1 WHERE key = ? AND status = 'pending' AND next_at <= ?")
    .run(now, key, now);
  if (claim.changes !== 1) return 'skipped';
  const row = ctx.db.prepare('SELECT * FROM outbox WHERE key = ?').get(key) as unknown as OutboxRow;
  const payload = JSON.parse(row.payload) as OutboxPayload;
  try {
    const providerId = await senders[row.channel](row, payload);
    ctx.db.prepare("UPDATE outbox SET status = 'sent', sent_at = ?, provider_message_id = ?, last_error = NULL WHERE key = ?").run(ctx.now(), providerId, key);
    return 'sent';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const retryable = e instanceof TelegramError ? e.retryable : e instanceof MailError ? e.retryable : !(e instanceof PermanentSendError);
    const tooOld = ctx.now() - row.created_at > OUTBOX_MAX_AGE_MS;
    if (!retryable || tooOld) {
      ctx.db.prepare("UPDATE outbox SET status = 'failed', last_error = ? WHERE key = ?").run(msg.slice(0, 500), key);
      ctx.log.warn({ key, err: msg }, 'outbox: permanent failure');
      return 'failed';
    }
    const retryAfter = e instanceof TelegramError ? e.retryAfterSec : null;
    ctx.db.prepare("UPDATE outbox SET status = 'pending', next_at = ?, last_error = ? WHERE key = ?").run(ctx.now() + backoffMs(row.attempts, retryAfter), msg.slice(0, 500), key);
    return 'retry';
  }
}

/** All given keys start at the same moment (§3 principle 2). */
export function kick(ctx: AppCtx, senders: Senders, keys: string[]): Promise<SendOutcome[]> {
  return Promise.all(keys.map((k) => sendKey(ctx, senders, k).catch(() => 'retry' as const)));
}

export async function processDue(ctx: AppCtx, senders: Senders, limit = 100): Promise<SendOutcome[]> {
  const now = ctx.now();
  ctx.db.prepare("UPDATE outbox SET status = 'pending' WHERE status = 'sending' AND started_at < ?").run(now - 120_000);
  const due = ctx.db.prepare("SELECT key FROM outbox WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT ?").all(now, limit) as { key: string }[];
  return kick(
    ctx,
    senders,
    due.map((d) => d.key),
  );
}

export interface DeliveryStatus {
  key: string;
  contactId: string | null;
  channel: Channel;
  kind: OutboxKind;
  status: string;
  attempts: number;
  lastError: string | null;
}

export function deliveryFor(ctx: AppCtx, eventId: string): DeliveryStatus[] {
  return (ctx.db.prepare('SELECT key, contact_id, channel, kind, status, attempts, last_error FROM outbox WHERE event_id = ? ORDER BY key').all(eventId) as {
    key: string;
    contact_id: string | null;
    channel: Channel;
    kind: OutboxKind;
    status: string;
    attempts: number;
    last_error: string | null;
  }[]).map((r) => ({ key: r.key, contactId: r.contact_id, channel: r.channel, kind: r.kind, status: r.status, attempts: r.attempts, lastError: r.last_error }));
}

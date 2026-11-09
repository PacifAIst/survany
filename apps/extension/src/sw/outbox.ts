/**
 * Local durable outbox (§10 "Backend unreachable", "All configured channels fail"). Each item has
 * its own key (event_id + contact + channel), so a retry never duplicates a send that succeeded.
 */
import * as store from './storage';

export type OutboxKind = 'backend-event' | 'backend-clip' | 'backend-notice' | 'telegram' | 'email';

export interface OutboxItem {
  key: string;
  kind: OutboxKind;
  payload: unknown;
  attempts: number;
  nextAt: number;
  createdAt: number;
  lastError: string | null;
}

export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function backoffMs(attempts: number, retryAfterSec: number | null = null): number {
  if (retryAfterSec !== null && retryAfterSec > 0) return retryAfterSec * 1000;
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 60 * 60 * 1000);
}

export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSec: number | null = null,
  ) {
    super(message);
  }
}

export async function enqueue(kind: OutboxKind, key: string, payload: unknown, error: string | null, now = Date.now()): Promise<void> {
  await store.update('outbox', (items) => {
    if (items.some((i) => i.key === key)) return items;
    return [...items, { key, kind, payload, attempts: 1, nextAt: now + backoffMs(1), createdAt: now, lastError: error }];
  });
}

export type Senders = Partial<Record<OutboxKind, (payload: unknown) => Promise<void>>>;

let running = false;

export interface OutboxResult {
  sent: string[];
  failed: string[];
  dropped: string[];
  pending: number;
}

/** Sends every due item once. Never runs concurrently within one service worker instance. */
export async function processOutbox(senders: Senders, now = Date.now()): Promise<OutboxResult> {
  const result: OutboxResult = { sent: [], failed: [], dropped: [], pending: 0 };
  if (running) return result;
  running = true;
  try {
    const items = await store.get('outbox');
    const keep: OutboxItem[] = [];
    for (const item of items) {
      if (now - item.createdAt > OUTBOX_MAX_AGE_MS) {
        result.dropped.push(item.key);
        await store.appendLog(`outbox: dropped ${item.key} after 24 h (${item.lastError ?? 'no error'})`);
        continue;
      }
      const send = senders[item.kind];
      if (item.nextAt > now || !send) {
        keep.push(item);
        continue;
      }
      try {
        await send(item.payload);
        result.sent.push(item.key);
      } catch (e) {
        const retryAfter = e instanceof RetryableError ? e.retryAfterSec : null;
        const attempts = item.attempts + 1;
        keep.push({ ...item, attempts, nextAt: now + backoffMs(attempts, retryAfter), lastError: e instanceof Error ? e.message : String(e) });
        result.failed.push(item.key);
      }
    }
    // Items enqueued while we were sending must not be lost: merge under the per-key lock.
    const handled = new Set(items.map((i) => i.key));
    const merged = await store.update('outbox', (latest) => [...keep, ...latest.filter((i) => !handled.has(i.key))]);
    result.pending = merged.length;
    return result;
  } finally {
    running = false;
  }
}

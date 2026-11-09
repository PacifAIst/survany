/**
 * Periodic backend duties: outbox retries, ack escalation (§6.4), the 5 s stream start budget
 * (§10), the dead-man alert (C19), approval timeouts (SG-01) and media retention (SG-22).
 */
import { existsSync, rmSync } from 'node:fs';
import { DEAD_MAN_MISSED_HEARTBEATS, HEARTBEAT_PERIOD_MINUTES, STREAM_START_BUDGET_MS } from '@survey-anything/shared';
import { expireApprovals } from './actions/approvals';
import { dispatchClip, dispatchEvent, notify } from './alerts/dispatcher';
import { processDue, type Senders } from './alerts/outbox';
import type { EventRow } from './alerts/templates';
import type { AppCtx } from './context';
import { endStream } from './stream/tokens';

export const DEAD_MAN_AFTER_MS = DEAD_MAN_MISSED_HEARTBEATS * HEARTBEAT_PERIOD_MINUTES * 60_000 + 15_000;

export async function escalateUnacknowledged(ctx: AppCtx, senders: Senders): Promise<number> {
  const now = ctx.now();
  const due = ctx.db
    .prepare('SELECT * FROM events WHERE acked_at IS NULL AND escalation_stage < 2 AND created_at + ack_timeout_sec * 1000 * (escalation_stage + 1) <= ?')
    .all(now) as unknown as EventRow[];
  for (const ev of due) {
    const stage = ev.escalation_stage + 1;
    ctx.db.prepare('UPDATE events SET escalation_stage = ? WHERE id = ? AND escalation_stage = ?').run(stage, ev.id, ev.escalation_stage);
    // Stage 1: the same recipients again. Stage 2: the owner (§6.4).
    await dispatchEvent(ctx, senders, ev, stage, stage === 1 ? undefined : ['owner']);
  }
  return due.length;
}

/** §10 "OME stream does not start in 5 s": the 10 s clip goes to every recipient on every channel. */
export async function enforceStreamStartBudget(ctx: AppCtx, senders: Senders): Promise<number> {
  const now = ctx.now();
  const late = ctx.db
    .prepare(
      `SELECT e.* FROM streams s JOIN events e ON e.id = s.event_id
       WHERE s.probe = 0 AND s.live_at IS NULL AND s.ended_at IS NULL AND s.created_at + ? <= ? AND e.clip_wanted = 0`,
    )
    .all(STREAM_START_BUDGET_MS, now) as unknown as EventRow[];
  for (const ev of late) {
    ctx.db.prepare('UPDATE events SET clip_wanted = 1 WHERE id = ?').run(ev.id);
    await dispatchClip(ctx, senders, ev);
  }
  return late.length;
}

export async function deadManCheck(ctx: AppCtx, senders: Senders): Promise<number> {
  const now = ctx.now();
  const dead = ctx.db.prepare('SELECT device_id, source_label, last_at FROM heartbeats WHERE armed = 1 AND dead_alerted_at IS NULL AND last_at < ?').all(now - DEAD_MAN_AFTER_MS) as {
    device_id: string;
    source_label: string | null;
    last_at: number;
  }[];
  for (const d of dead) {
    ctx.db.prepare('UPDATE heartbeats SET dead_alerted_at = ? WHERE device_id = ?').run(now, d.device_id);
    await notify(
      ctx,
      senders,
      ['owner'],
      `deadman:${d.device_id}:${d.last_at}`,
      '🚨 Monitoring stopped',
      `The browser watching "${d.source_label ?? 'a source'}" (${d.device_id}) has been silent since ${new Date(d.last_at).toISOString()}. The computer, browser or network may be down. Nothing is being watched.`,
    );
  }
  return dead.length;
}

export async function endExpiredStreams(ctx: AppCtx): Promise<number> {
  const rows = ctx.db.prepare('SELECT id FROM streams WHERE ended_at IS NULL AND expires_at <= ?').all(ctx.now()) as { id: string }[];
  for (const r of rows) {
    endStream(ctx.db, r.id, ctx.now());
    await ctx.ome?.deleteStream(r.id).catch(() => undefined);
  }
  return rows.length;
}

/**
 * SECURITY-GATE SG-22: snapshots and clips are deleted after MEDIA_RETENTION_HOURS (default 24 h); 0 deletes them as soon as the event's viewer links have expired and no clip send is pending.
 */
export function applyRetention(ctx: AppCtx): number {
  const now = ctx.now();
  const hours = ctx.env.MEDIA_RETENTION_HOURS;
  const rows =
    hours > 0
      ? (ctx.db.prepare('SELECT id, snapshot_path, clip_path FROM events WHERE created_at < ? AND (snapshot_path IS NOT NULL OR clip_path IS NOT NULL)').all(now - hours * 3_600_000) as {
          id: string;
          snapshot_path: string | null;
          clip_path: string | null;
        }[])
      : (ctx.db
          .prepare(
            `SELECT e.id, e.snapshot_path, e.clip_path FROM events e
             WHERE (e.snapshot_path IS NOT NULL OR e.clip_path IS NOT NULL)
               AND NOT EXISTS (SELECT 1 FROM streams s WHERE s.event_id = e.id AND s.expires_at > ?)
               AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.event_id = e.id AND o.status IN ('pending', 'sending'))`,
          )
          .all(now) as { id: string; snapshot_path: string | null; clip_path: string | null }[]);
  for (const r of rows) {
    for (const p of [r.snapshot_path, r.clip_path]) if (p && existsSync(p)) rmSync(p, { force: true });
    ctx.db.prepare('UPDATE events SET snapshot_path = NULL, clip_path = NULL, clip_mime = NULL WHERE id = ?').run(r.id);
  }
  return rows.length;
}

export async function tick(ctx: AppCtx, senders: Senders): Promise<void> {
  const steps: [string, () => Promise<unknown> | unknown][] = [
    ['outbox', () => processDue(ctx, senders)],
    ['escalation', () => escalateUnacknowledged(ctx, senders)],
    ['stream-budget', () => enforceStreamStartBudget(ctx, senders)],
    ['dead-man', () => deadManCheck(ctx, senders)],
    ['approvals', () => expireApprovals(ctx)],
    ['streams', () => endExpiredStreams(ctx)],
    ['retention', () => applyRetention(ctx)],
  ];
  for (const [name, fn] of steps) {
    try {
      await fn();
    } catch (e) {
      ctx.log.error({ err: String(e), step: name }, 'watchdog step failed');
    }
  }
}

export function startWatchdog(ctx: AppCtx, senders: Senders, everyMs = 2000): () => void {
  let running = false;
  const t = setInterval(() => {
    if (running) return;
    running = true;
    void tick(ctx, senders).finally(() => {
      running = false;
    });
  }, everyMs);
  return () => clearInterval(t);
}

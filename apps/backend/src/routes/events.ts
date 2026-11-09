// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/** Event API (§4.3 steps 4-5). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventSubmissionSchema, isUuidV4 } from '@survey-anything/shared';
import type { FastifyInstance } from 'fastify';
import { dispatchEvent, getEvent } from '../alerts/dispatcher';
import { deliveryFor, type Senders } from '../alerts/outbox';
import { type AppCtx, iceServers } from '../context';
import { sanitizeLabel, sanitizeReason } from '../security/sanitize';
import { createStream, endStream, mintToken } from '../stream/tokens';
import { requireDevice } from './common';

export function whipUrl(ctx: AppCtx, publisherToken: string): string {
  const base = (ctx.env.OME_SIGNALING_BASE ?? '').replace(/\/+$/, '');
  return `${base}/${ctx.env.OME_APP}/${publisherToken}?direction=whip&transport=all`;
}

export function registerEventRoutes(app: FastifyInstance, ctx: AppCtx, senders: Senders): void {
  const auth = requireDevice(ctx);

  app.post('/api/events', { preHandler: auth, bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const parsed = EventSubmissionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid event', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    const e = parsed.data;
    const device = req.device;
    if (!device) return reply.code(401).send({ error: 'device required' });
    const now = ctx.now();
    let snapshotPath: string | null = null;
    if (e.snapshotJpegB64) {
      const bytes = Buffer.from(e.snapshotJpegB64, 'base64');
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return reply.code(400).send({ error: 'snapshot is not a JPEG' });
      mkdirSync(ctx.mediaDir, { recursive: true });
      snapshotPath = join(ctx.mediaDir, `${e.eventId}.jpg`);
      writeFileSync(snapshotPath, bytes);
    }
    const inserted = ctx.db
      .prepare(
        `INSERT OR IGNORE INTO events(id, device_id, rule, rule_title, severity, confirmed, unconfirmed_reason, confidence, provider, reason, ts, source_label, recipients, channels, ack_timeout_sec, created_at, snapshot_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.eventId,
        device.id,
        e.rule,
        sanitizeLabel(e.ruleTitle, 80),
        e.severity,
        e.confirmed ? 1 : 0,
        e.unconfirmedReason,
        e.confidence,
        e.provider ? sanitizeLabel(e.provider, 40) : null,
        sanitizeReason(e.reason),
        e.timestamp,
        sanitizeLabel(e.sourceLabel, 120),
        JSON.stringify([...new Set(e.recipients)]),
        JSON.stringify([...new Set(e.channels)]),
        e.ackTimeoutSec,
        now,
        snapshotPath,
      );
    if (inserted.changes === 0) {
      // Idempotent retry from the extension's outbox: the original dispatch already ran.
      return { eventId: e.eventId, deduplicated: true, stream: null };
    }
    let stream: { whipUrl: string; expiresAt: string; iceServers: ReturnType<typeof iceServers> } | null = null;
    if (e.wantLiveView && ctx.feats.liveView) {
      const s = createStream(ctx.db, device.id, e.eventId, e.streamTtlMinutes, now);
      const publisher = mintToken(ctx.db, s, 'publisher', { now });
      stream = { whipUrl: whipUrl(ctx, publisher), expiresAt: new Date(s.expires_at).toISOString(), iceServers: iceServers(ctx) };
    }
    const ev = getEvent(ctx, e.eventId);
    if (ev) {
      // The alert never waits for the stream (§4.3 step 4). All channels start together.
      void dispatchEvent(ctx, senders, ev).catch((err: unknown) => ctx.log.error({ err: String(err), eventId: e.eventId }, 'dispatch failed'));
    }
    return { eventId: e.eventId, deduplicated: false, stream };
  });

  app.get<{ Params: { id: string } }>('/api/events/:id/delivery', { preHandler: auth }, async (req, reply) => {
    if (!isUuidV4(req.params.id)) return reply.code(400).send({ error: 'bad id' });
    const ev = getEvent(ctx, req.params.id);
    if (!ev || ev.device_id !== req.device?.id) return reply.code(404).send({ error: 'unknown event' });
    return { eventId: ev.id, acked: ev.acked_at !== null, ackedBy: ev.acked_by, delivery: deliveryFor(ctx, ev.id) };
  });

  /** Stop button and stream TTL: revoke every token and cut the stream in OME. */
  app.post<{ Params: { id: string } }>('/api/events/:id/stop', { preHandler: auth }, async (req, reply) => {
    if (!isUuidV4(req.params.id)) return reply.code(400).send({ error: 'bad id' });
    const ev = getEvent(ctx, req.params.id);
    if (!ev || ev.device_id !== req.device?.id) return reply.code(404).send({ error: 'unknown event' });
    await stopEventStreams(ctx, ev.id);
    return { stopped: true };
  });
}

export async function stopEventStreams(ctx: AppCtx, eventId: string): Promise<number> {
  const streams = ctx.db.prepare('SELECT id FROM streams WHERE event_id = ? AND ended_at IS NULL').all(eventId) as { id: string }[];
  for (const s of streams) {
    endStream(ctx.db, s.id, ctx.now());
    await ctx.ome?.deleteStream(s.id).catch((e: unknown) => ctx.log.warn({ err: String(e) }, 'OME stream delete failed'));
  }
  return streams.length;
}

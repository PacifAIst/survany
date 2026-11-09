// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Clip upload (§4.3 step 4). The backend holds the latest 10 s clip for every alerted event and
 * sends it only on a §10 failure path (stream not live in 5 s, or a viewer's ladder exhausted).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isUuidV4 } from '@survey-anything/shared';
import type { FastifyInstance } from 'fastify';
import { getEvent } from '../alerts/dispatcher';
import { kick, type Senders } from '../alerts/outbox';
import type { AppCtx } from '../context';
import { requireDevice } from './common';

const CLIP_MAX = 50 * 1024 * 1024;
const ALLOWED = ['video/mp4', 'video/webm'];

export function registerClipRoutes(app: FastifyInstance, ctx: AppCtx, senders: Senders): void {
  app.addContentTypeParser(ALLOWED, { parseAs: 'buffer', bodyLimit: CLIP_MAX }, (_req, body, done) => done(null, body));

  app.post<{ Params: { id: string } }>('/api/events/:id/clip', { preHandler: requireDevice(ctx), bodyLimit: CLIP_MAX }, async (req, reply) => {
    if (!isUuidV4(req.params.id)) return reply.code(400).send({ error: 'bad id' });
    const ev = getEvent(ctx, req.params.id);
    if (!ev || ev.device_id !== req.device?.id) return reply.code(404).send({ error: 'unknown event' });
    const mime = String(req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
    if (!ALLOWED.includes(mime) || !Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'clip must be video/mp4 or video/webm' });
    const body = req.body;
    mkdirSync(ctx.mediaDir, { recursive: true });
    const path = join(ctx.mediaDir, `${ev.id}.${mime === 'video/mp4' ? 'mp4' : 'webm'}`);
    writeFileSync(path, body);
    ctx.db.prepare('UPDATE events SET clip_path = ?, clip_mime = ? WHERE id = ?').run(path, mime, ev.id);
    // A failure path may already be waiting for this clip: release those sends now.
    const waiting = ctx.db.prepare("SELECT key FROM outbox WHERE event_id = ? AND kind = 'clip' AND status = 'pending'").all(ev.id) as { key: string }[];
    if (waiting.length > 0) {
      ctx.db.prepare("UPDATE outbox SET next_at = ? WHERE event_id = ? AND kind = 'clip' AND status = 'pending'").run(ctx.now(), ev.id);
      void kick(ctx, senders, waiting.map((w) => w.key));
    }
    return { stored: true, bytes: body.length };
  });
}

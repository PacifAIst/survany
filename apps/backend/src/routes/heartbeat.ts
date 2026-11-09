/** Heartbeat (C19) and operational notices from the extension (§10). */
import { HeartbeatSchema, NoticeSchema } from '@survey-anything/shared';
import type { FastifyInstance } from 'fastify';
import { notify } from '../alerts/dispatcher';
import type { Senders } from '../alerts/outbox';
import type { AppCtx } from '../context';
import { sanitizeLabel } from '../security/sanitize';
import { requireDevice } from './common';

const NOTICE_TITLES: Record<string, string> = {
  'budget-exhausted': 'AI budget reached: unconfirmed alerts only until tomorrow',
  'camera-offline': 'Camera offline',
  're-arm-needed': 'Re-arm needed',
  'offscreen-failed': 'Capture stopped',
  'live-view-udp-unavailable': 'Live view will use the TCP relay',
  'channel-failing': 'An alert channel is failing',
};

export function registerHeartbeatRoutes(app: FastifyInstance, ctx: AppCtx, senders: Senders): void {
  const auth = requireDevice(ctx);

  app.post('/api/heartbeat', { preHandler: auth }, async (req, reply) => {
    const hb = HeartbeatSchema.safeParse(req.body);
    if (!hb.success || !req.device) return reply.code(400).send({ error: 'invalid heartbeat' });
    ctx.db
      .prepare(
        `INSERT INTO heartbeats(device_id, last_at, armed, source_kind, source_label, dead_alerted_at) VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(device_id) DO UPDATE SET last_at = excluded.last_at, armed = excluded.armed, source_kind = excluded.source_kind, source_label = excluded.source_label, dead_alerted_at = NULL`,
      )
      .run(req.device.id, ctx.now(), hb.data.armed ? 1 : 0, hb.data.sourceKind, sanitizeLabel(hb.data.sourceLabel, 120));
    return { ok: true };
  });

  app.post('/api/notices', { preHandler: auth }, async (req, reply) => {
    const n = NoticeSchema.safeParse(req.body);
    if (!n.success || !req.device) return reply.code(400).send({ error: 'invalid notice' });
    const title = NOTICE_TITLES[n.data.kind] ?? 'Survey Anything notice';
    await notify(ctx, senders, ['owner'], `notice:${req.device.id}:${n.data.kind}:${ctx.now()}`, title, sanitizeLabel(n.data.detail, 500));
    return { ok: true };
  });
}

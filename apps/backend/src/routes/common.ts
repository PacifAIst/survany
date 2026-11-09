import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppCtx } from '../context';
import { tokenHash } from '../security/hmac';
import { RateLimiter } from '../security/rate-limit';

export interface DeviceRow {
  id: string;
  name: string;
  revoked: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    device?: DeviceRow;
    rawBody?: Buffer;
  }
}

const deviceLimiters = new WeakMap<AppCtx, RateLimiter>();

/**
 * SECURITY-GATE SG-16: every extension call carries a device token obtained through a one-time pairing code; tokens are stored hashed and rate-limited per device.
 */
export function requireDevice(ctx: AppCtx) {
  const perDevice = deviceLimiters.get(ctx) ?? new RateLimiter(240, 60_000, ctx.now);
  deviceLimiters.set(ctx, perDevice);
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const h = req.headers.authorization;
    const m = h ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(h) : null;
    if (!m?.[1]) {
      await reply.code(401).send({ error: 'device token required' });
      return;
    }
    const d = ctx.db.prepare('SELECT id, name, revoked FROM devices WHERE token_hash = ?').get(tokenHash(m[1])) as DeviceRow | undefined;
    if (!d || d.revoked) {
      await reply.code(401).send({ error: 'unknown or revoked device' });
      return;
    }
    if (!perDevice.take(d.id)) {
      await reply.code(429).header('retry-after', '60').send({ error: 'rate limited' });
      return;
    }
    ctx.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(ctx.now(), d.id);
    req.device = d;
  };
}

export function clientIp(req: FastifyRequest): string {
  return req.ip;
}

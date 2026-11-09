/**
 * Survey Anything backend (§4.1).
 * SECURITY-GATE SG-25: every response carries a link to the corresponding source (AGPL-3.0 §13), and /source redirects to it.
 */
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeSenders } from './alerts/dispatcher';
import { SmtpMailer, type Mailer } from './alerts/email';
import type { Senders } from './alerts/outbox';
import { TelegramApi } from './alerts/telegram';
import { ConfirmGateClient, type GateClient, type GateDevice } from './actions/gate-client';
import { loadPolicy, type Policy } from './actions/policy';
import { registerActionRoutes } from './actions/proposer';
import { features, loadEnv, type Env } from './config';
import type { AppCtx, Logger } from './context';
import { openDb, type Db } from './db/migrate';
import { registerClipRoutes } from './routes/clips';
import { registerEventRoutes } from './routes/events';
import { registerHeartbeatRoutes } from './routes/heartbeat';
import { registerOmeRoutes } from './routes/ome-admission';
import { registerPairingRoutes } from './routes/pairing';
import { registerProxyRoutes } from './routes/proxy';
import { registerTelegramWebhook } from './routes/telegram-webhook';
import { registerViewerRoutes } from './routes/viewer';
import type { Resolver } from './security/ssrf';
import { OmeClient } from './stream/ome-client';
import { startWatchdog } from './watchdog';

export interface BuildOptions {
  env: Env;
  db?: Db;
  mailer?: Mailer | null;
  telegram?: TelegramApi | null;
  gate?: GateClient | null;
  policy?: Policy | null;
  now?: () => number;
  resolver?: Resolver;
  logger?: boolean;
}

export function gateDeviceFromDb(db: Db): GateDevice | null {
  const r = db.prepare("SELECT value FROM meta WHERE key = 'gate_device'").get() as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as GateDevice) : null;
}

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; ctx: AppCtx; senders: Senders }> {
  const env = opts.env;
  const db = opts.db ?? openDb(join(env.DATA_DIR, 'survey-anything.db'));
  const app = Fastify({ logger: opts.logger ?? true, trustProxy: env.TRUST_PROXY, bodyLimit: 1024 * 1024 });
  const log: Logger = {
    info: (o, m) => app.log.info(o, m),
    warn: (o, m) => app.log.warn(o, m),
    error: (o, m) => app.log.error(o, m),
  };
  const gateDevice = gateDeviceFromDb(db);
  const ctx: AppCtx = {
    db,
    env,
    feats: features(env),
    telegram: opts.telegram !== undefined ? opts.telegram : env.TELEGRAM_BOT_TOKEN ? new TelegramApi(env.TELEGRAM_API_BASE, env.TELEGRAM_BOT_TOKEN) : null,
    mailer: opts.mailer !== undefined ? opts.mailer : env.SMTP_URL && env.MAIL_FROM ? new SmtpMailer(env.SMTP_URL, env.MAIL_FROM) : null,
    ome: env.OME_API_URL && env.OME_API_TOKEN ? new OmeClient(env.OME_API_URL, env.OME_API_TOKEN, env.OME_APP) : null,
    gate: opts.gate !== undefined ? opts.gate : env.GATE_URL && env.GATE_AGENT_TOKEN && gateDevice ? new ConfirmGateClient(env.GATE_URL, env.GATE_AGENT_TOKEN, gateDevice) : null,
    mediaDir: join(env.DATA_DIR, 'media'),
    now: opts.now ?? Date.now,
    log,
  };
  const senders = makeSenders(ctx);
  let policy: Policy | null = opts.policy ?? null;
  if (opts.policy === undefined && process.env['GATE_POLICY_PATH']) policy = loadPolicy(process.env['GATE_POLICY_PATH']);

  // Keep the raw body: the OME admission signature is computed over the exact bytes.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    req.rawBody = body;
    if (body.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      const err = new Error('invalid JSON') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-source-code', env.SOURCE_URL);
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-content-type-options', 'nosniff');
    return payload;
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/source', async (_req, reply) => reply.redirect(env.SOURCE_URL, 302));

  registerPairingRoutes(app, ctx, senders);
  registerEventRoutes(app, ctx, senders);
  registerClipRoutes(app, ctx, senders);
  registerHeartbeatRoutes(app, ctx, senders);
  registerTelegramWebhook(app, ctx, senders);
  registerOmeRoutes(app, ctx);
  registerViewerRoutes(app, ctx, senders);
  registerProxyRoutes(app, ctx, opts.resolver);
  registerActionRoutes(app, ctx, senders, policy);
  registerStreamProbeRoutes(app, ctx);

  return { app, ctx, senders };
}

import { requireDevice } from './routes/common';
import { createStream, mintToken } from './stream/tokens';
import { whipUrl } from './routes/events';
import { iceServers } from './context';
import { PROBE_TOKEN_TTL_SECONDS } from '@survey-anything/shared';
import { z } from 'zod';

/** M5 arm-time reachability probe: a 30 s publish token for a synthetic black track. */
function registerStreamProbeRoutes(app: FastifyInstance, ctx: AppCtx): void {
  const auth = requireDevice(ctx);
  app.post('/api/stream/probe', { preHandler: auth }, async (req, reply) => {
    if (!ctx.feats.liveView || !req.device) return reply.code(404).send({ error: 'live view not configured' });
    const s = createStream(ctx.db, req.device.id, null, 1, ctx.now(), true, PROBE_TOKEN_TTL_SECONDS * 1000);
    const token = mintToken(ctx.db, s, 'probe', { now: ctx.now() });
    return { whipUrl: whipUrl(ctx, token), iceServers: iceServers(ctx), expiresAt: new Date(s.expires_at).toISOString() };
  });
  app.post('/api/stream/probe-result', { preHandler: auth }, async (req, reply) => {
    const b = z.object({ candidateType: z.enum(['udp', 'tcp', 'relay', 'none']) }).strict().safeParse(req.body);
    if (!b.success || !req.device) return reply.code(400).send({ error: 'invalid' });
    ctx.db.prepare("INSERT INTO probe_reports(at, device_id, side, candidate_type) VALUES (?, ?, 'publisher', ?)").run(ctx.now(), req.device.id, b.data.candidateType);
    return { ok: true };
  });
}

async function main(): Promise<void> {
  const env = loadEnv();
  const { app, ctx, senders } = await buildApp({ env });
  const stop = startWatchdog(ctx, senders);
  if (ctx.telegram && env.TELEGRAM_WEBHOOK_SECRET) {
    await ctx.telegram
      .setWebhook(`${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/telegram/webhook`, env.TELEGRAM_WEBHOOK_SECRET)
      .catch((e: unknown) => app.log.warn({ err: String(e) }, 'setWebhook failed; alerts still send, but buttons need the webhook'));
  }
  const close = async (): Promise<void> => {
    stop();
    await app.close();
    ctx.db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void close());
  process.on('SIGINT', () => void close());
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info({ features: ctx.feats }, 'Survey Anything backend listening');
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('server.js') || entry.endsWith('server.ts')) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}

export { OmeClient };

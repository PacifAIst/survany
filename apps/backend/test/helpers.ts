// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SMTPServer } from 'smtp-server';
import { loadEnv, type Env } from '../src/config';
import { openDb } from '../src/db/migrate';
import { buildApp, type BuildOptions } from '../src/server';
import { hashPin } from '../src/security/pin';
import { createPairingCode } from '../src/routes/pairing';

// Obviously fake test values. They must never look like real credentials (no `\d{8,10}:<35 chars>` bot-token shape):
// GitHub secret scanning and gitleaks (.gitleaks.toml) both run on this repository.
export const BOT_TOKEN = 'TEST_BOT_TOKEN_NOT_REAL';
export const WEBHOOK_SECRET = 'whsec_test_not_real';
export const OME_SECRET = 'ome_secret_test_not_real';

export interface TgCall {
  method: string;
  at: number;
  fields: Record<string, string>;
}

export type FailMode = 'ok' | '500' | '429' | 'down' | '403';

export async function startFakeTelegram(): Promise<{ url: string; calls: TgCall[]; setMode: (m: FailMode) => void; close: () => Promise<void> }> {
  const calls: TgCall[] = [];
  let mode: FailMode = 'ok';
  let messageId = 1000;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const at = Date.now();
        if (mode === 'down') {
          req.socket.destroy();
          return;
        }
        const method = (req.url ?? '').split('/').pop() ?? '';
        const body = Buffer.concat(chunks);
        const fields: Record<string, string> = {};
        const ct = req.headers['content-type'] ?? '';
        if (ct.includes('multipart/form-data')) {
          const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': ct }, body }).formData();
          for (const [k, v] of form.entries()) fields[k] = typeof v === 'string' ? v : `<file ${v.size}>`;
        } else if (body.length) {
          for (const [k, v] of Object.entries(JSON.parse(body.toString('utf8')) as Record<string, unknown>)) fields[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }
        calls.push({ method, at, fields });
        res.setHeader('content-type', 'application/json');
        if (mode === '500') {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error_code: 500, description: 'Internal Server Error' }));
          return;
        }
        if (mode === '429') {
          res.statusCode = 429;
          res.end(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } }));
          return;
        }
        if (mode === '403') {
          res.statusCode = 403;
          res.end(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }));
          return;
        }
        res.end(JSON.stringify({ ok: true, result: method.startsWith('send') ? { message_id: messageId++ } : true }));
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    setMode: (m) => {
      mode = m;
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export interface Mail {
  to: string;
  at: number;
  raw: string;
}

export async function startFakeSmtp(): Promise<{ url: string; mails: Mail[]; setMode: (m: 'ok' | '451' | '550') => void; close: () => Promise<void> }> {
  const mails: Mail[] = [];
  let mode: 'ok' | '451' | '550' = 'ok';
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onRcptTo(addr, _s, cb) {
      if (mode === '451') {
        const e = new Error('Temporary failure') as Error & { responseCode: number };
        e.responseCode = 451;
        return cb(e);
      }
      if (mode === '550') {
        const e = new Error('Mailbox unavailable') as Error & { responseCode: number };
        e.responseCode = 550;
        return cb(e);
      }
      cb();
      void addr;
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      const at = Date.now();
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        mails.push({ to: session.envelope.rcptTo.map((r) => r.address).join(','), at, raw: Buffer.concat(chunks).toString('utf8') });
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.server.address() as AddressInfo).port;
  return {
    url: `smtp://127.0.0.1:${port}`,
    mails,
    setMode: (m) => {
      mode = m;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export interface Clock {
  now: () => number;
  advance: (ms: number) => void;
}

export function clock(start = Date.now()): Clock {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

export function testEnv(over: Record<string, string> = {}): Env {
  return loadEnv({
    PUBLIC_BASE_URL: 'https://alerts.example.org',
    DATA_DIR: mkdtempSync(join(tmpdir(), 'sa-backend-')),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_BOT_USERNAME: 'survey_test_bot',
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    OME_ENABLED: 'true',
    OME_PUBLIC_HOST: 'live.example.org',
    OME_SIGNALING_BASE: 'https://live.example.org',
    OME_LLHLS_BASE: 'https://live.example.org',
    OME_ADMISSION_SECRET: OME_SECRET,
    FORWARD_AUTH_SECRET: 'fwd_secret',
    MAIL_FROM: 'alerts@example.org',
    ...over,
  });
}

export async function makeApp(opts: { tg?: string; smtp?: string; env?: Record<string, string>; clock?: Clock } & Omit<Partial<BuildOptions>, 'env'> = {}) {
  const env = testEnv({
    ...(opts.tg ? { TELEGRAM_API_BASE: opts.tg } : {}),
    ...(opts.smtp ? { SMTP_URL: opts.smtp } : {}),
    ...(opts.env ?? {}),
  });
  const db = openDb(':memory:');
  const { tg: _tg, smtp: _smtp, env: _env, clock: _clock, ...buildOpts } = opts;
  const built = await buildApp({ env, db, logger: false, ...(opts.clock ? { now: opts.clock.now } : {}), ...buildOpts });
  await built.app.ready();
  const code = createPairingCode(built.ctx);
  const pair = await built.app.inject({ method: 'POST', url: '/api/pair/device', payload: { code, name: 'test browser' } });
  const { deviceToken, deviceId } = pair.json() as { deviceToken: string; deviceId: string };
  return { ...built, deviceToken, deviceId, auth: { authorization: `Bearer ${deviceToken}` } };
}

export function addContact(db: ReturnType<typeof openDb>, id: string, o: { roles?: string[]; tgUser?: number; email?: string; pin?: string } = {}): void {
  db.prepare('INSERT INTO contacts(id, roles, channels, telegram_user_id, telegram_chat_id, email, pin_hash, created_at, paired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    JSON.stringify(o.roles ?? ['viewer']),
    JSON.stringify(['telegram', 'email']),
    o.tgUser !== undefined ? String(o.tgUser) : null,
    o.tgUser !== undefined ? String(o.tgUser) : null,
    o.email ?? null,
    o.pin ? hashPin(o.pin) : null,
    Date.now(),
    Date.now(),
  );
}

export function eventBody(over: Record<string, unknown> = {}) {
  return {
    eventId: randomUUID(),
    rule: 'fire',
    ruleTitle: 'Fire or smoke',
    severity: 'critical',
    confirmed: true,
    unconfirmedReason: null,
    confidence: 0.91,
    provider: 'local',
    reason: 'Flames visible near the stove.',
    timestamp: new Date().toISOString(),
    sourceLabel: 'Kitchen camera',
    recipients: ['owner'],
    channels: ['telegram', 'email'],
    snapshotJpegB64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]).toString('base64'),
    wantLiveView: false,
    ackTimeoutSec: 300,
    streamTtlMinutes: 10,
    ...over,
  };
}

/** Builds Telegram Mini App initData signed exactly as Telegram does (S14). */
export function signInitData(fields: Record<string, string>, botToken = BOT_TOKEN): string {
  const dcs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  const p = new URLSearchParams(fields);
  p.set('hash', hash);
  return p.toString();
}

export async function waitUntil(fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

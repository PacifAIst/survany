// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * M3 / §9 "allowCloudProviders:false": a Playwright network log of every http(s) request the extension
 * makes (service worker and offscreen document included) while it detects, confirms and alerts.
 * Requirement: zero requests to non-local hosts carry image bytes (JPEG/PNG base64, raw JPEG, multipart
 * image parts). Text-only alerts are allowed.
 *
 * Set-up: T0 (no backend), Vision provider = a local model mock, direct Telegram + direct email (Resend),
 * egress.alertMedia off. Non-local hosts never see real traffic: every such request is recorded and
 * answered by the test. Then, as a contrast, the user explicitly turns egress.alertMedia on and the next
 * alert does carry its snapshot, which shows the block is the flag and not an accident of the set-up.
 * Needs `pnpm build:e2e`.
 */
import { expect, test } from '@playwright/test';
import { EXAMPLE_CONFIG_JSON } from '@survey-anything/shared';
import { acceptConsentAndCamera, type DebugStats, DIST_E2E, type Harness, launch } from './harness';
import { type ModelMock, startModelMock } from './model-mock';

interface Logged {
  url: string;
  host: string;
  local: boolean;
  method: string;
  bytes: number;
  imageBytes: string | null;
  at: number;
}

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** What kind of image content a request body carries, if any. */
function imageIn(body: Buffer | null): string | null {
  if (!body || body.length === 0) return null;
  const text = body.toString('latin1');
  if (text.includes('/9j/')) return 'jpeg-base64';
  if (text.includes('iVBORw0KGgo')) return 'png-base64';
  if (/content-type:\s*image\//i.test(text)) return 'multipart-image';
  if (body.includes(JPEG_MAGIC)) return 'jpeg-bytes';
  return null;
}

const isLocalHost = (h: string): boolean => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

let h: Harness;
let mock: ModelMock;
const log: Logged[] = [];

test.afterAll(async () => {
  await h?.close();
  await mock?.close();
});

const recipe = (id: string) => ({ id, title: `Network test (${id})`, gate: { type: 'motion', pixelDelta: 8, threshold: 0.001 }, confirm: { prompt: 'Is anything moving in this image?', framesPerCheck: 1 }, severity: 'info' });

function config(rule: string, alertMedia: boolean): Record<string, unknown> {
  return {
    ...structuredClone(EXAMPLE_CONFIG_JSON),
    provider: { id: 'local', baseUrl: `${mock.url}/v1`, model: 'mock-vision', apiKeyRef: null },
    providerProfiles: {},
    failoverChain: ['local'],
    reasoner: { enabled: false, providerId: null, model: null },
    allowCloudProviders: false,
    proxyMode: false,
    egress: { alertMedia, liveView: false },
    vision: { ...EXAMPLE_CONFIG_JSON.vision, enableVision: true, scanIntervalMs: 1000 },
    alerts: { channels: ['telegram', 'email'], email: { transport: 'http-direct', includeSnapshot: true }, ackTimeoutSec: 300 },
    contacts: { owner: { roles: ['viewer', 'approver'] } },
    routing: { [rule]: ['owner'] },
    rules: [rule],
    mcp: { ...EXAMPLE_CONFIG_JSON.mcp, enabled: false },
    direct: {
      telegram: { botTokenRef: 'key_telegram_bot', chatIds: { owner: '111' } },
      email: { provider: 'resend', apiKeyRef: 'key_resend', from: 'alerts@example.org', addresses: { owner: 'owner@example.org' } },
    },
  };
}

async function alertOnce(rule: string, alertMedia: boolean): Promise<Logged[]> {
  const since = Date.now();
  const saved = await h.send<{ ok: boolean; errors: string[] }>({ type: 'save-config', config: config(rule, alertMedia) });
  expect(saved.value, JSON.stringify(saved)).toEqual({ ok: true, errors: [] });
  expect((await h.send({ type: 'arm', source: { kind: 'camera', label: 'Network test camera' } })).ok).toBe(true);
  const sent = () => log.filter((l) => l.at >= since && !l.local);
  const deadline = Date.now() + 90_000;
  while (!(sent().some((l) => l.host === 'api.telegram.org') && sent().some((l) => l.host === 'api.resend.com'))) {
    if (Date.now() > deadline) {
      const dbg = await h.send<DebugStats>({ type: 'debug-stats' });
      throw new Error(`no alert within 90 s; log:\n${dbg.value?.log.join('\n')}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 1500)); // let any trailing request land
  await h.send({ type: 'disarm' });
  return log.filter((l) => l.at >= since);
}

test('§9 allowCloudProviders:false: no image bytes to any non-local host; alerts still go out as text', async () => {
  mock = await startModelMock({
    confirm: (user) => JSON.stringify({ event: /Allowed values for "event": "([a-z0-9-]+)"/.exec(user)?.[1] ?? 'none', confidence: 0.9, reason: 'Something moved.' }),
    reason: () => '{"tool":"none"}',
  });
  h = await launch({ dist: DIST_E2E });
  await h.context.route(/^https?:\/\//, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const body = req.postDataBuffer();
    const local = isLocalHost(u.hostname);
    log.push({ url: `${u.origin}${u.pathname.replace(/bot[^/]+/, 'bot<token>')}`, host: u.hostname, local, method: req.method(), bytes: body?.length ?? 0, imageBytes: imageIn(body), at: Date.now() });
    if (local) return route.continue();
    // Non-local hosts never get real traffic.
    const json = u.hostname === 'api.telegram.org' ? { ok: true, result: { message_id: 1 } } : { id: 'test-email-id' };
    return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(json) });
  });
  await acceptConsentAndCamera(h);
  await h.page.evaluate(async (rs) => {
    await chrome.storage.local.set({ importedRecipes: rs, secrets: { key_telegram_bot: 'TEST_BOT_TOKEN_NOT_REAL', key_resend: 'resend_test_key_not_real' } });
  }, [recipe('net-text-only'), recipe('net-with-media')]);

  // 1) alertMedia off: the frame goes to the local model only.
  const off = await alertOnce('net-text-only', false);
  const offRemote = off.filter((l) => !l.local);
  const offLocalConfirm = off.filter((l) => l.local && l.method === 'POST' && l.imageBytes);
  expect(offRemote.length).toBeGreaterThanOrEqual(2);
  expect(offRemote.filter((l) => l.imageBytes), JSON.stringify(offRemote, null, 1)).toEqual([]);
  expect(offRemote.some((l) => l.url.endsWith('/sendMessage'))).toBe(true);
  expect(offRemote.some((l) => l.url.endsWith('/sendPhoto'))).toBe(false);
  expect(offLocalConfirm.length).toBeGreaterThanOrEqual(1); // the local model did see the frame

  // 2) Contrast: the user turns alert media on, and only then does a snapshot leave.
  const on = await alertOnce('net-with-media', true);
  const onRemote = on.filter((l) => !l.local);
  expect(onRemote.some((l) => l.imageBytes && l.host === 'api.telegram.org' && l.url.endsWith('/sendPhoto'))).toBe(true);

  test.info().annotations.push({ type: 'network-log', description: JSON.stringify({ alertMediaOff: offRemote.map((l) => `${l.method} ${l.url} ${l.bytes}B image=${l.imageBytes ?? 'none'}`), alertMediaOn: onRemote.map((l) => `${l.method} ${l.url} ${l.bytes}B image=${l.imageBytes ?? 'none'}`) }) });
  console.info('NETWORK LOG (alertMedia off):', offRemote.map((l) => `${l.method} ${l.url} ${l.bytes}B image=${l.imageBytes ?? 'none'}`).join(' | '));
  console.info('NETWORK LOG (alertMedia on):', onRemote.map((l) => `${l.method} ${l.url} ${l.bytes}B image=${l.imageBytes ?? 'none'}`).join(' | '));
});

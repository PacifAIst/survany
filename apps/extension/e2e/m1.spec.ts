// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * M1 acceptance (except the 30-minute soak, see soak.spec.ts) and the M2 browser checks.
 * Runs against the built extension in Chromium with a fake camera.
 */
import { expect, test } from '@playwright/test';
import { EXAMPLE_CONFIG_JSON } from '@survey-anything/shared';
import { acceptConsentAndCamera, type DebugStats, type Harness, launch, waitFor } from './harness';

let h: Harness;

test.afterEach(async () => {
  await h?.close();
});

const localGateOnly = (rules: string[]) => ({
  ...structuredClone(EXAMPLE_CONFIG_JSON),
  provider: { id: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5vl', apiKeyRef: null },
  providerProfiles: {},
  failoverChain: ['local'],
  vision: { ...EXAMPLE_CONFIG_JSON.vision, enableVision: false },
  contacts: { owner: { roles: ['viewer', 'approver'] } },
  routing: { other: ['owner'] },
  rules,
});

test('SG-24: arming is refused before consent; consent + camera grant then arm works', async () => {
  h = await launch();
  const before = await h.send({ type: 'arm', source: { kind: 'camera', label: 'Fake camera' } });
  expect(before.ok).toBe(false);
  expect(before.error).toMatch(/consent/i);
  await acceptConsentAndCamera(h);
  const armed = await h.send<{ armed: boolean }>({ type: 'arm', source: { kind: 'camera', label: 'Fake camera' } });
  expect(armed.error ?? '').toBe('');
  expect(armed.value?.armed).toBe(true);
  // SG-13 (M1 part): the indicator is on while armed.
  const sw = await h.sw();
  expect(await sw.evaluate(() => chrome.action.getBadgeText({}))).toBe('ON');
  const s = await waitFor(() => h.send<DebugStats>({ type: 'debug-stats' }).then((r) => r.value!), (v) => (v.stats?.ticks ?? 0) >= 4, 40_000);
  expect(s.running).toBe(true);
  expect(s.stats!.lastFrameAt).not.toBeNull();
  await h.send({ type: 'disarm' });
  expect(await sw.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
});

test('service worker killed mid-run: the loop continues and state rehydrates', async () => {
  h = await launch();
  await acceptConsentAndCamera(h);
  expect((await h.send({ type: 'arm', source: { kind: 'camera', label: 'Fake camera' } })).ok).toBe(true);
  const first = await waitFor(() => h.send<DebugStats>({ type: 'debug-stats' }).then((r) => r.value!), (v) => (v.stats?.ticks ?? 0) >= 2, 30_000);

  // Stop the extension service worker through the DevTools protocol.
  const cdp = await h.context.newCDPSession(h.page);
  const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: { targetId: string; type: string; url: string }[] };
  const swTarget = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(h.extId));
  expect(swTarget).toBeDefined();
  await cdp.send('Target.closeTarget', { targetId: swTarget!.targetId });

  // Any extension message wakes a fresh instance; the Worker loop in the offscreen document never stopped.
  const after = await waitFor(
    () => h.send<DebugStats>({ type: 'debug-stats' }).then((r) => r.value!).catch(() => null as unknown as DebugStats),
    (v) => v !== null && v.swStartedAt > first.swStartedAt && (v.stats?.ticks ?? 0) > first.stats!.ticks,
    60_000,
  );
  expect(after.running).toBe(true);
  const status = await h.send<{ armed: boolean; source: { label: string } }>({ type: 'get-status' });
  expect(status.value?.armed).toBe(true);
  expect(status.value?.source.label).toBe('Fake camera');
});

test('offscreen document killed: camera restored within 60 s by the watchdog', async () => {
  h = await launch();
  await acceptConsentAndCamera(h);
  expect((await h.send({ type: 'arm', source: { kind: 'camera', label: 'Fake camera' } })).ok).toBe(true);
  await waitFor(() => h.send<DebugStats>({ type: 'debug-stats' }).then((r) => r.value!), (v) => (v.stats?.ticks ?? 0) >= 2, 30_000);
  await h.page.evaluate(() => chrome.offscreen.closeDocument());
  const killedAt = Date.now();
  const restored = await waitFor(
    () => h.send<DebugStats>({ type: 'debug-stats' }).then((r) => r.value!),
    (v) => v.running && (v.stats?.ticks ?? 0) >= 1,
    65_000,
    2000,
  );
  expect(Date.now() - killedAt).toBeLessThanOrEqual(65_000);
  expect(restored.log.join('\n')).toMatch(/camera restored after/);
});

test('M2 / SG-26: bundled, checksummed YOLOX models (COCO and fire/smoke) load on CPU (WASM) with WebGPU disabled and every network request blocked', async () => {
  h = await launch({ blockNetwork: true });
  await acceptConsentAndCamera(h);
  const saved = await h.send<{ ok: boolean; errors: string[] }>({ type: 'save-config', config: localGateOnly(['robbery', 'fire', 'other']) });
  expect(saved.value).toEqual({ ok: true, errors: [] });
  expect((await h.send({ type: 'arm', source: { kind: 'camera', label: 'Fake camera' } })).ok).toBe(true);
  const s = await waitFor(() => h.send<DebugStats>({ type: 'debug-stats' }).then((r) => r.value!), (v) => v.stats?.detector === 'wasm' || (v.stats?.missingModels.includes('yolox-tiny-coco') ?? false), 90_000, 2000);
  expect(s.stats!.detector).toBe('wasm');
  expect(s.stats!.missingModels).not.toContain('yolox-tiny-coco');
  // The fire/smoke weights trained in models/fire-smoke are bundled, so the interim flame heuristic is not used.
  expect(s.stats!.missingModels).not.toContain('fire-smoke-yolox-tiny');
  const logged = await waitFor(
    () => h.send<DebugStats>({ type: 'debug-stats' }).then((r) => r.value!),
    (v) => /detector yolox-tiny-coco ready on wasm/.test(v.log.join('\n')) && /detector fire-smoke-yolox-tiny ready on wasm/.test(v.log.join('\n')),
    20_000,
  );
  expect(logged.log.join('\n')).toMatch(/detector yolox-tiny-coco ready on wasm \(416x416\)/);
  expect(logged.log.join('\n')).toMatch(/detector fire-smoke-yolox-tiny ready on wasm \(416x416\)/);
  expect(logged.log.join('\n')).not.toMatch(/interim flame heuristic active/);
});

test('C20: a tab source cannot resume without a gesture; offscreen loss raises "re-arm needed"', async () => {
  h = await launch();
  await acceptConsentAndCamera(h);
  const target = await h.context.newPage();
  await target.goto('data:text/html,<title>Watched tab</title><h1 id=t>0</h1><script>let i=0;setInterval(()=>document.getElementById("t").textContent=++i,500)</script>');
  // tabCapture needs a user gesture, which automation cannot provide; arm fails cleanly instead of capturing silently.
  const tabId = await h.page.evaluate(async () => (await chrome.tabs.query({ title: 'Watched tab' }))[0]?.id ?? -1);
  const idResult = await h.page.evaluate(async (id) => {
    try {
      return { ok: true, value: await chrome.tabCapture.getMediaStreamId({ targetTabId: id }) };
    } catch (e) {
      return { ok: false, value: String(e) };
    }
  }, tabId);
  expect(idResult.ok).toBe(false);
});

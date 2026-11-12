// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { EXAMPLE_CONFIG_JSON, parseConfig } from '@survey-anything/shared';
import { CAMERA_CONSTRAINTS } from '../src/offscreen/source-camera';
import { pickMime } from '../src/offscreen/clip-recorders';
import { ensureWhipQuery } from '../src/offscreen/whip-publisher';
import { importConfigJson, toggleChannel } from '../src/options/model';
import { BudgetLedger, type BudgetState } from '../src/sw/budget';
import { applyEgressPolicy } from '../src/sw/egress-policy';
import { egressDecision, type PolicyConfig } from '../src/sw/guarded-fetch';
import { initialRuleState, onCandidate, onClear, onConfirmed, STALE_CONFIRMING_MS } from '../src/sw/rule-state';
import { buildManifest } from '../manifest.config';
import { installChromeMock } from './chrome-mock';

const T = { cooldownMs: 60_000, risingEdgeOnly: true };

describe('per-rule state machine (§6.4)', () => {
  it('idle -> confirming -> alerted/cooldown; rising edge needs a clear before re-alerting', () => {
    let s = initialRuleState(0);
    let r = onCandidate(s, 1000, T, 'candidate');
    expect(r.decision).toBe('confirm');
    s = onConfirmed(r.next, 2000, T, { kind: 'alert', eventId: 'e1' });
    expect(s.phase).toBe('cooldown');
    expect(onCandidate(s, 3000, T, 'still-hot').decision).toBe('ignore'); // cooling down
    expect(onCandidate(s, 70_000, T, 'still-hot').decision).toBe('ignore'); // cooled, but never cleared
    s = onClear(s, 70_001);
    expect(s.phase).toBe('idle');
    r = onCandidate(s, 70_002, T, 'candidate');
    expect(r.decision).toBe('confirm');
  });

  it('without risingEdgeOnly, a persistent event re-alerts after the cooldown', () => {
    const t = { ...T, risingEdgeOnly: false };
    const s = onConfirmed(onCandidate(initialRuleState(0), 1, t, 'candidate').next, 2, t, { kind: 'alert', eventId: 'e' });
    expect(onCandidate(s, 60_003, t, 'still-hot').decision).toBe('confirm');
  });

  it('a "none" answer re-asks a still-hot gate at most once per cooldown', () => {
    let s = onConfirmed(onCandidate(initialRuleState(0), 1, T, 'candidate').next, 10, T, { kind: 'none' });
    expect(onCandidate(s, 30_000, T, 'still-hot').decision).toBe('ignore');
    expect(onCandidate(s, 70_000, T, 'still-hot').decision).toBe('confirm');
    s = onCandidate(s, 70_000, T, 'candidate').next;
    expect(s.phase).toBe('confirming');
  });

  it('concurrent candidates while confirming are ignored; a stale confirm (SW died mid-call) is abandoned', () => {
    const c = onCandidate(initialRuleState(0), 0, T, 'candidate').next;
    expect(onCandidate(c, 5_000, T, 'candidate').decision).toBe('ignore');
    expect(onCandidate(c, STALE_CONFIRMING_MS + 1, T, 'candidate').decision).toBe('confirm');
  });
});

describe('messages come only from this extension (Chrome and Firefox)', () => {
  it('accepts its own pages in either browser and refuses everything else', async () => {
    const { isFromExtension } = await import('../src/sw/messages');
    const g = globalThis as unknown as { chrome: unknown };
    const prev = g.chrome;
    try {
      for (const base of ['chrome-extension://abcdefgh/', 'moz-extension://5e5e5e5e-0000-4000-8000-000000000001/']) {
        // Firefox: runtime.id is the add-on id, while page URLs use a per-install UUID.
        const id = base.startsWith('moz') ? 'survany@pacifaist' : 'abcdefgh';
        g.chrome = { runtime: { id, getURL: (p: string) => base + p } };
        expect(isFromExtension({ id, url: `${base}src/options/index.html` })).toBe(true);
        expect(isFromExtension({ id, url: 'https://evil.example/' })).toBe(false);
        expect(isFromExtension({ id: 'other-extension', url: `${base}src/options/index.html` })).toBe(false);
        expect(isFromExtension({ id })).toBe(false);
      }
    } finally {
      g.chrome = prev;
    }
  });
});

describe('budget report for the Options page (M3)', () => {
  it('reports use against each limit, which limit blocked, and the next UTC midnight', async () => {
    const limits = { maxCallsPerMinute: 5, dailyMaxApiCalls: 2, dailyTokenCap: 10_000, hardStopOnBudget: true as const };
    let st: BudgetState = { day: '', dayCalls: 0, dayTokens: 0, minute: [], noticeDay: null, freeDayCalls: 0 };
    const now = () => Date.parse('2026-11-09T21:30:00Z');
    const l = await BudgetLedger.load(limits, async () => st, async (s) => void (st = structuredClone(s)), now);
    const call = { cloud: true, providerId: 'openai', model: 'm' };
    await l.begin(call);
    await l.addTokens(call, 1200);
    expect(l.report()).toMatchObject({ day: '2026-11-09', dayCalls: 1, dayTokens: 1200, minuteCalls: 1, exhausted: false, blockedBy: null, resetsAt: '2026-11-10T00:00:00.000Z' });
    await l.begin(call);
    expect(l.report()).toMatchObject({ dayCalls: 2, exhausted: true, blockedBy: 'day-calls' });
    // Local calls are free and never blocked, but they are counted separately so the popup shows them,
    // also on top of state saved before localDayCalls existed.
    const local = { cloud: false, providerId: 'local', model: 'x' };
    expect(l.allow(local)).toBe(true);
    await l.begin(local);
    await l.begin(local);
    expect(l.report()).toMatchObject({ dayCalls: 2, localDayCalls: 2 });
    expect(st.localDayCalls).toBe(2);
  });
});

describe('budget engine survives restarts and hard-stops (M3)', () => {
  const limits = { maxCallsPerMinute: 2, dailyMaxApiCalls: 3, dailyTokenCap: 1000, hardStopOnBudget: true as const };
  let saved: BudgetState | null = null;
  const load = async (): Promise<BudgetState> => saved ?? { day: '', dayCalls: 0, dayTokens: 0, minute: [], noticeDay: null, freeDayCalls: 0 };
  const save = async (s: BudgetState): Promise<void> => {
    saved = structuredClone(s);
  };
  const call = { cloud: true, providerId: 'openai', model: 'm' };
  beforeEach(() => {
    saved = null;
  });

  it('per-minute, per-day and token caps block cloud calls; local calls are free', async () => {
    let now = Date.UTC(2026, 10, 9, 10, 0, 0);
    let l = await BudgetLedger.load(limits, load, save, () => now);
    await l.begin(call);
    await l.begin(call);
    expect(l.block(call)).toBe('minute');
    expect(l.allow({ ...call, cloud: false })).toBe(true);
    now += 61_000;
    // Simulated service worker restart: a fresh ledger from storage.
    l = await BudgetLedger.load(limits, load, save, () => now);
    expect(l.allow(call)).toBe(true);
    await l.begin(call);
    expect(l.block(call)).toBe('day-calls');
    expect(await l.claimExhaustedNotice()).toBe(true);
    l = await BudgetLedger.load(limits, load, save, () => now);
    expect(await l.claimExhaustedNotice()).toBe(false); // one notice per day, across restarts
    now += 24 * 3600_000;
    l = await BudgetLedger.load(limits, load, save, () => now);
    expect(l.allow(call)).toBe(true);
    await l.addTokens(call, 1000);
    expect(l.block(call)).toBe('day-tokens');
  });

  it('models OpenRouter :free quotas (C27)', async () => {
    const l = await BudgetLedger.load({ ...limits, dailyMaxApiCalls: 1000, maxCallsPerMinute: 600 }, load, save, () => Date.UTC(2026, 10, 9));
    const free = { cloud: true, providerId: 'openrouter', model: 'qwen/qwen2.5-vl-72b-instruct:free' };
    for (let i = 0; i < 20; i++) await l.begin(free);
    expect(l.block(free)).toBe('openrouter-free-minute');
  });
});

describe('SG-14 and SG-15: guardedFetch egress policy', () => {
  const base: PolicyConfig = { allowCloudProviders: true, proxyMode: false, egress: { alertMedia: true, liveView: true }, backend: { url: null } };
  const jpegBody = JSON.stringify({ image: '/9j/4AAQSkZJRgABAQ' });

  it('allowCloudProviders:false blocks cloud provider hosts and allows loopback/RFC 1918', () => {
    const p = { ...base, allowCloudProviders: false };
    expect(egressDecision('https://api.openai.com/v1/chat/completions', { body: jpegBody }, { purpose: 'provider', frames: 'provider-frame' }, p)).toMatch(/allowCloudProviders/);
    expect(egressDecision('http://127.0.0.1:11434/v1/chat/completions', { body: jpegBody }, { purpose: 'provider', frames: 'provider-frame' }, p)).toBeNull();
    expect(egressDecision('http://192.168.1.5:8000/v1/chat/completions', { body: jpegBody }, { purpose: 'provider', frames: 'provider-frame' }, p)).toBeNull();
  });

  it('alert media needs egress.alertMedia; undeclared image bytes are always blocked', () => {
    expect(egressDecision('https://api.telegram.org/botX/sendPhoto', { body: jpegBody }, { purpose: 'telegram-direct', frames: 'alert-media' }, { ...base, egress: { alertMedia: false, liveView: true } })).toMatch(/alertMedia/);
    expect(egressDecision('https://api.telegram.org/botX/sendMessage', { body: jpegBody }, { purpose: 'telegram-direct', frames: 'none' }, base)).toMatch(/not declared/);
    expect(egressDecision('https://api.telegram.org/botX/sendMessage', { body: '{"text":"hi"}' }, { purpose: 'telegram-direct', frames: 'none' }, base)).toBeNull();
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
    expect(egressDecision('https://b.example/api/events/x/clip', { body: jpegBytes }, { purpose: 'backend', frames: 'none' }, base)).toMatch(/not declared/);
  });

  it('provider frames go only to providers or the proxy backend; proxyMode forces the backend', () => {
    expect(egressDecision('https://evil.example/', { body: jpegBody }, { purpose: 'email-direct', frames: 'provider-frame' }, base)).toMatch(/only go to a provider/);
    const proxy = { ...base, proxyMode: true, backend: { url: 'https://alerts.example.org' } };
    expect(egressDecision('https://api.openai.com/v1/chat/completions', { body: jpegBody }, { purpose: 'provider', frames: 'provider-frame' }, proxy)).toMatch(/proxyMode/);
    expect(egressDecision('https://alerts.example.org/api/proxy/analyze', { body: jpegBody }, { purpose: 'backend', frames: 'provider-frame' }, proxy)).toBeNull();
  });

  it('rejects non-http schemes', () => {
    expect(egressDecision('file:///etc/passwd', {}, { purpose: 'backend', frames: 'none' }, base)).toMatch(/scheme/);
  });

  it('Test Connection: the synthetic probe image goes only to the provider under test, and respects allowCloudProviders', () => {
    const png = JSON.stringify({ image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg' });
    const probe = { purpose: 'probe', frames: 'synthetic-probe' } as const;
    expect(egressDecision('https://openrouter.ai/api/v1/chat/completions', { body: png }, probe, base)).toBeNull();
    expect(egressDecision('https://openrouter.ai/api/v1/chat/completions', { body: png }, probe, { ...base, allowCloudProviders: false })).toMatch(/allowCloudProviders/);
    expect(egressDecision('http://127.0.0.1:11434/v1/chat/completions', { body: png }, probe, { ...base, allowCloudProviders: false })).toBeNull();
    // The probe label cannot carry captured frames, and nothing else can use the probe label.
    expect(egressDecision('https://openrouter.ai/api/v1/chat/completions', { body: jpegBody }, { purpose: 'probe', frames: 'provider-frame' }, base)).toMatch(/only the synthetic probe/);
    expect(egressDecision('https://api.telegram.org/botX/sendPhoto', { body: png }, { purpose: 'telegram-direct', frames: 'synthetic-probe' }, base)).toMatch(/provider being tested/);
  });

  it('applyEgressPolicy strips the snapshot and live view when their flags are off', () => {
    const r = parseConfig({ ...structuredClone(EXAMPLE_CONFIG_JSON), egress: { alertMedia: false, liveView: false } });
    if (!r.ok) throw new Error(r.errors.join());
    const sub = applyEgressPolicy(
      {
        eventId: crypto.randomUUID(), rule: 'fire', ruleTitle: 'Fire', severity: 'critical', confirmed: true, unconfirmedReason: null,
        confidence: 0.9, provider: 'local', reason: 'x', timestamp: new Date().toISOString(), sourceLabel: 's', recipients: ['owner'],
        channels: ['telegram'], snapshotJpegB64: '/9j/abc', wantLiveView: true, ackTimeoutSec: 300, streamTtlMinutes: 10,
      },
      r.config,
    );
    expect(sub.snapshotJpegB64).toBeNull();
    expect(sub.wantLiveView).toBe(false);
  });
});

describe('SG-23: capture is video only', () => {
  it('camera constraints never request audio', () => {
    expect(CAMERA_CONSTRAINTS(null).audio).toBe(false);
    expect(CAMERA_CONSTRAINTS('dev1').audio).toBe(false);
  });

  it('the manifest requests no microphone, no content scripts and only optional host access', () => {
    const m = buildManifest({ version: '0.1.0' });
    expect(m.content_scripts).toBeUndefined();
    expect(m.host_permissions).toBeUndefined();
    expect(m.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
    expect(JSON.stringify(m)).not.toMatch(/audio|microphone|externally_connectable/i);
    expect(m.content_security_policy?.extension_pages).toBe("script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
    expect(m.minimum_chrome_version).toBe('120');
  });

  it('only the e2e test build pre-grants host access, and only to the two loopback origins', () => {
    expect(buildManifest({ version: '0.1.0', e2eLoopbackHosts: false }).host_permissions).toBeUndefined();
    expect(buildManifest({ version: '0.1.0', e2eLoopbackHosts: true }).host_permissions).toEqual(['http://localhost/*', 'http://127.0.0.1/*', 'https://api.telegram.org/*', 'https://api.resend.com/*']);
  });

  it('the shipped dist/manifest.json, when built, has no host_permissions', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const p = join(__dirname, '..', 'dist', 'manifest.json');
    if (!existsSync(p)) return;
    expect((JSON.parse(readFileSync(p, 'utf8')) as { host_permissions?: unknown }).host_permissions).toBeUndefined();
  });
});

describe('Options page model', () => {
  it('import: a single-channel file without the acknowledgement asks for it instead of failing', async () => {
    const { importConfigJson: imp, needsNonRedundantAck } = await import('../src/options/model');
    const single = { ...structuredClone(EXAMPLE_CONFIG_JSON), alerts: { ...EXAMPLE_CONFIG_JSON.alerts, channels: ['email'] } };
    const r = imp(JSON.stringify(single));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.needsAck).toBeDefined();
    expect(needsNonRedundantAck(r.needsAck!)).toBe(false);
    expect(parseConfig(r.needsAck).ok).toBe(true);
    // A file with zero channels is simply refused (no acknowledgement can fix it).
    const zero = imp(JSON.stringify({ ...single, alerts: { ...single.alerts, channels: [] } }));
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.needsAck).toBeUndefined();
  });

  it('a single channel needs the one-time acknowledgement; zero channels are refused', () => {
    const d = structuredClone(EXAMPLE_CONFIG_JSON) as unknown as Record<string, unknown>;
    const r1 = toggleChannel(d, 'email', false, false);
    expect(r1.needsAck).toBe(true);
    const r2 = toggleChannel(d, 'email', false, true);
    expect((r2.draft['alerts'] as { channels: string[]; nonRedundantAck: boolean }).channels).toEqual(['telegram']);
    expect(parseConfig(r2.draft).ok).toBe(true);
    const r3 = toggleChannel(r2.draft, 'telegram', false, true);
    expect(r3.refused).toMatch(/At least one/);
  });

  it('import re-validates and refuses embedded keys', () => {
    expect(importConfigJson(JSON.stringify(EXAMPLE_CONFIG_JSON)).ok).toBe(true);
    expect(importConfigJson(JSON.stringify({ ...EXAMPLE_CONFIG_JSON, alerts: { ...EXAMPLE_CONFIG_JSON.alerts, channels: [] } })).ok).toBe(false);
    const withKey = importConfigJson(JSON.stringify({ ...EXAMPLE_CONFIG_JSON, note: 'sk-abcdefghijklmnopqrstuvwxyz012345' }));
    expect(withKey.ok).toBe(false);
  });

  it('local card: picks the loaded vision model LM Studio reports, and says what is missing otherwise', async () => {
    const { pickLocalModel } = await import('../src/options/model');
    const lm = (models: { id: string; vision: boolean; loaded: boolean }[]) => ({ reachable: true, server: 'lmstudio' as const, models, error: null });
    // The owner's LM Studio on 2026-11-11: one vision model, loaded; text models not loaded.
    const owner = lm([
      { id: 'qwen3-vl-4b-instruct', vision: true, loaded: true },
      { id: 'llama-3.2-3b-instruct', vision: false, loaded: false },
      { id: 'gemma-4-e4b-it', vision: false, loaded: false },
    ]);
    expect(pickLocalModel(owner, 'qwen2.5vl')).toMatchObject({ model: 'qwen3-vl-4b-instruct', ok: true });
    expect(pickLocalModel(owner, 'qwen2.5vl').message).toMatch(/can see images and is loaded in LM Studio/);
    // A loaded vision model wins over a downloaded one; the current one is kept when it fits.
    const two = lm([{ id: 'vl-a', vision: true, loaded: false }, { id: 'vl-b', vision: true, loaded: true }]);
    expect(pickLocalModel(two, null).model).toBe('vl-b');
    expect(pickLocalModel(lm([{ id: 'vl-a', vision: true, loaded: false }]), null).message).toMatch(/not loaded yet/);
    // No vision model: nothing is filled in and the message says what to do.
    const none = pickLocalModel(lm([{ id: 'llama-3.2-3b-instruct', vision: false, loaded: true }]), 'qwen2.5vl');
    expect(none).toMatchObject({ model: null, ok: false });
    expect(none.message).toMatch(/no model that can see images \(it has: llama-3.2-3b-instruct\)/);
    // Other servers only list ids.
    const plain = { reachable: true, server: 'openai-compatible' as const, models: [{ id: 'qwen2.5vl:7b', vision: null, loaded: null }], error: null };
    expect(pickLocalModel(plain, 'qwen2.5vl:7b')).toMatchObject({ model: 'qwen2.5vl:7b', ok: true });
    expect(pickLocalModel(plain, 'qwen2.5vl')).toMatchObject({ model: null, ok: false, message: expect.stringMatching(/This server has: qwen2.5vl:7b/) });
    // Nothing running.
    const down = pickLocalModel({ reachable: false, server: null, models: [], error: 'nothing answered at http://127.0.0.1:11434/v1: is the server running?' }, 'qwen2.5vl');
    expect(down).toMatchObject({ model: null, ok: false });
    expect(down.message).toMatch(/LM Studio: Developer tab → Start server \(address http:\/\/127.0.0.1:1234\)/);
  });

  it('recipe library: a template is a valid recipe with a fresh id; the editor validates like an import and refuses built-in ids', async () => {
    const { BUILTIN_RECIPES, importRecipe } = await import('@survey-anything/recipes');
    const { checkNewRecipe, recipeTemplate } = await import('../src/options/model');
    const builtinIds = BUILTIN_RECIPES.map((r) => r.id);
    const zone = BUILTIN_RECIPES.find((r) => r.id === 'person-in-restricted-zone')!;
    // Every built-in, copied as a template, is accepted as-is and does not collide with anything.
    for (const r of BUILTIN_RECIPES) {
      const t = checkNewRecipe(recipeTemplate(r as never, builtinIds), builtinIds, importRecipe);
      expect(t.ok, r.id).toBe(true);
      if (t.ok) expect(builtinIds).not.toContain(t.recipe.id);
    }
    const first = JSON.parse(recipeTemplate(zone as never, builtinIds)) as { id: string; title: string; gate: unknown };
    expect(first).toMatchObject({ id: 'person-in-restricted-zone-custom', title: `${zone.title} (custom)`, gate: zone.gate });
    // A second template from the same rule gets the next free id.
    expect(JSON.parse(recipeTemplate(zone as never, [...builtinIds, first.id])).id).toBe('person-in-restricted-zone-custom-2');
    // A built-in id is refused with a suggestion; empty text and invalid recipes list what is wrong.
    const dup = checkNewRecipe(JSON.stringify(zone), builtinIds, importRecipe);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors[0]).toMatch(/built-in rule: choose another id \(for example "person-in-restricted-zone-custom"\)/);
    const empty = checkNewRecipe('  ', builtinIds, importRecipe);
    expect(empty).toEqual({ ok: false, errors: ['paste or type a recipe first'] });
    const bad = checkNewRecipe(JSON.stringify({ ...first, severity: 'apocalyptic', webhook: 'https://example.invalid' }), builtinIds, importRecipe);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.length).toBeGreaterThan(0);
    const notJson = checkNewRecipe('{ "id": ', builtinIds, importRecipe);
    expect(notJson.ok).toBe(false);
  });
});

describe('clips and WHIP URLs', () => {
  it('prefers MP4 when the encoder exists, else WebM (C11)', () => {
    expect(pickMime((m) => m.startsWith('video/mp4'))).toBe('video/mp4;codecs=avc1');
    expect(pickMime((m) => m.startsWith('video/webm'))).toBe('video/webm;codecs=vp9');
  });

  it('WHIP URLs always carry direction=whip and transport=all (D11)', () => {
    const u = new URL(ensureWhipQuery('https://ome.example.org/app/tok?x=1&transport=udptcp'));
    expect(u.searchParams.get('direction')).toBe('whip');
    expect(u.searchParams.get('transport')).toBe('all');
    expect(u.searchParams.get('x')).toBe('1');
  });
});

describe('outbox (durable local retries)', () => {
  it('keys de-duplicate, failures back off, retryable errors honour retry-after, successes leave', async () => {
    installChromeMock();
    const { enqueue, processOutbox, RetryableError, backoffMs } = await import('../src/sw/outbox');
    await enqueue('telegram', 'e1:owner:telegram', { n: 1 }, 'down', 0);
    await enqueue('telegram', 'e1:owner:telegram', { n: 2 }, 'down', 0);
    await enqueue('email', 'e1:owner:email', { n: 3 }, 'down', 0);
    let attempts = 0;
    const r1 = await processOutbox(
      {
        telegram: async () => {
          attempts++;
          throw new RetryableError('429', 7);
        },
        email: async () => undefined,
      },
      backoffMs(1) + 1,
    );
    expect(attempts).toBe(1);
    expect(r1.sent).toEqual(['e1:owner:email']);
    expect(r1.failed).toEqual(['e1:owner:telegram']);
    const items = (await chrome.storage.local.get('outbox'))['outbox'] as { nextAt: number; attempts: number }[];
    expect(items).toHaveLength(1);
    expect(items[0]!.nextAt).toBe(backoffMs(1) + 1 + 7000);
    expect(items[0]!.attempts).toBe(2);
  });
});

describe('SG-13 live indicator must be verified before streaming', () => {
  it('beginLiveIndicator sets LIVE, the banner and a notification', async () => {
    const mock = installChromeMock();
    const { beginLiveIndicator, endLiveIndicator } = await import('../src/sw/badge');
    await beginLiveIndicator('ev1', ['contactA']);
    expect(mock.badge.text).toBe('LIVE');
    expect(((await chrome.storage.local.get('streaming'))['streaming'] as { recipients: string[] }).recipients).toEqual(['contactA']);
    expect(mock.notifications).toContain('sa-live');
    await endLiveIndicator(null);
    expect(mock.badge.text).toBe('');
  });

  it('throws (so no stream starts) if the badge cannot be verified', async () => {
    installChromeMock();
    (chrome.action as unknown as { getBadgeText: () => Promise<string> }).getBadgeText = async () => '';
    const { beginLiveIndicator } = await import('../src/sw/badge');
    await expect(beginLiveIndicator('ev2', ['x'])).rejects.toThrow(/SG-13/);
  });
});

describe('SG-26 bundled assets only, checksum-verified', () => {
  it('refuses any asset URL outside the extension package', async () => {
    const { fetchBundledAsset } = await import('../src/sw/guarded-fetch');
    await expect(fetchBundledAsset('https://cdn.example/model.onnx', 'chrome-extension://abc/')).rejects.toThrow(/not inside the extension package/);
    await expect(fetchBundledAsset('chrome-extension://other/model.onnx', 'chrome-extension://abc/')).rejects.toThrow(/not inside the extension package/);
    // Firefox packages: the same rules with moz-extension:// (another add-on, or a web URL, is refused).
    await expect(fetchBundledAsset('moz-extension://other-uuid/model.onnx', 'moz-extension://5e5e-uuid/')).rejects.toThrow(/not inside the extension package/);
    await expect(fetchBundledAsset('https://cdn.example/model.onnx', 'moz-extension://5e5e-uuid/')).rejects.toThrow(/not inside the extension package/);
    await expect(fetchBundledAsset('chrome-extension://5e5e-uuid/model.onnx', 'moz-extension://5e5e-uuid/')).rejects.toThrow(/not inside the extension package/);
    await expect(fetchBundledAsset('moz-extension://x/m.onnx', 'https://example.org/')).rejects.toThrow(/not inside the extension package/);
  });

  it('rejects a model whose SHA-256 differs from checksums.json, and one not listed at all', async () => {
    const { loadVerifiedAsset, ChecksumMismatchError } = await import('../src/worker/detector');
    const bytes = new TextEncoder().encode('model-bytes');
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(bytes)) as typeof fetch;
    try {
      const good = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const list = [{ name: 'm', path: 'models/m.onnx', sha256: good, license: 'Apache-2.0' }];
      await expect(loadVerifiedAsset('models/m.onnx', 'chrome-extension://abc/', list)).resolves.toBeInstanceOf(ArrayBuffer);
      await expect(loadVerifiedAsset('models/m.onnx', 'chrome-extension://abc/', [{ ...list[0]!, sha256: '0'.repeat(64) }])).rejects.toBeInstanceOf(ChecksumMismatchError);
      await expect(loadVerifiedAsset('models/other.onnx', 'chrome-extension://abc/', list)).rejects.toThrow(/not listed/);
    } finally {
      globalThis.fetch = real;
    }
  });
});

// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
import { inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bytesToBase64 } from '@survey-anything/shared';
import {
  AllProvidersFailedError,
  analyzeWithFailover,
  anthropicImageTokens,
  base64ToBlob,
  createProvider,
  type ChainEntry,
  parseDetection,
  ProviderError,
  renderProbeImage,
  PROBE_ALPHABET,
  PROBE_LAYOUT,
  probeReadingMatches,
  randomProbeCode,
} from '../src';
import { anthropicReply, json, type MockServer, openAiReply, startMock } from './mock-server';
import { readProbeCode } from './probe-reader';

const readCodeFromRequest = (dataUrl: string): string => readProbeCode(Buffer.from(dataUrl.split(',')[1] ?? '', 'base64'));

const fetchFn = (url: string, init: RequestInit): Promise<Response> => fetch(url, init);
const jpeg = (): Blob => base64ToBlob('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJ', 'image/jpeg');
const okDetection = JSON.stringify({ event: 'fire', confidence: 0.92, reason: 'Flames visible near the stove.' });

let mock: MockServer;
beforeEach(async () => {
  mock = await startMock((_r, res) => json(res, 200, openAiReply(okDetection)));
});
afterEach(async () => {
  await mock.close();
});

function provider(id: 'openai' | 'openrouter' | 'deepseek' | 'local' | 'anthropic', baseSuffix: string, opts: { apiKey?: string | null; timeoutMs?: number; directBrowser?: boolean } = {}) {
  return createProvider({
    id,
    baseUrl: mock.url + baseSuffix,
    model: 'test-model',
    apiKey: opts.apiKey === undefined ? 'sk-test' : opts.apiKey,
    timeoutMs: opts.timeoutMs ?? 5000,
    fetchFn,
    ...(opts.directBrowser !== undefined ? { directBrowser: opts.directBrowser } : {}),
  });
}

describe('openai-compatible adapters: request shape', () => {
  it.each([
    ['openai', '/v1', '/v1/chat/completions'],
    ['openrouter', '/api/v1', '/api/v1/chat/completions'],
    ['deepseek', '', '/chat/completions'],
    ['local', '/v1', '/v1/chat/completions'],
  ] as const)('%s posts to %s', async (id, suffix, path) => {
    const p = provider(id, suffix, { apiKey: id === 'local' ? null : 'sk-test' });
    const r = await p.analyze(jpeg(), 'Is there fire?', { allowedEvents: ['fire'], maxOutputTokens: 200 });
    expect(r).toEqual({ event: 'fire', confidence: 0.92, reason: 'Flames visible near the stove.' });
    const req = mock.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe(path);
    if (id === 'local') expect(req.headers.authorization).toBeUndefined();
    else expect(req.headers.authorization).toBe('Bearer sk-test');
    expect(req.body.model).toBe('test-model');
    expect(req.body.max_completion_tokens).toBe(200);
    expect(req.body.max_tokens).toBeUndefined();
    expect(req.body.response_format).toEqual({ type: 'json_object' });
    expect(req.body.temperature).toBeUndefined();
    const sys = req.body.messages[0];
    expect(sys.role).toBe('system');
    expect(sys.content).toMatch(/UNTRUSTED DATA/);
    const user = req.body.messages[1].content;
    expect(user[0].type).toBe('text');
    expect(user[0].text).toContain('Is there fire?');
    expect(user[1].type).toBe('image_url');
    expect(user[1].image_url.url).toMatch(/^data:image\/jpeg;base64,\/9j\//);
  });

  it('C25: retries once with max_tokens when the server rejects max_completion_tokens', async () => {
    mock.setHandler((r, res) => {
      if (r.body.max_completion_tokens !== undefined) return json(res, 400, { error: { message: 'Unrecognized request argument supplied: max_completion_tokens' } });
      return json(res, 200, openAiReply(okDetection));
    });
    const p = provider('local', '/v1');
    await p.analyze(jpeg(), 'q', { allowedEvents: ['fire'], maxOutputTokens: 150 });
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[1]!.body.max_tokens).toBe(150);
    expect(mock.requests[1]!.body.max_completion_tokens).toBeUndefined();
  });

  it('drops response_format once when unsupported, then stops retrying', async () => {
    mock.setHandler((_r, res) => json(res, 400, { error: { message: 'response_format is not supported' } }));
    const p = provider('local', '/v1');
    await expect(p.analyze(jpeg(), 'q', { allowedEvents: ['fire'], maxOutputTokens: 150 })).rejects.toMatchObject({ kind: 'bad-request' });
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[1]!.body.response_format).toBeUndefined();
  });

  it('reports usage for the budget engine', async () => {
    const p = provider('openai', '/v1');
    let usage = { inputTokens: 0, outputTokens: 0 };
    await p.analyze(jpeg(), 'q', { allowedEvents: ['fire'], maxOutputTokens: 200, onUsage: (u) => (usage = u) });
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });
});

describe('anthropic adapter: request shape (C24)', () => {
  beforeEach(() => mock.setHandler((_r, res) => json(res, 200, anthropicReply(okDetection))));

  it('uses anthropic-version 2026-10-21, x-api-key, a base64 image block and no sampling parameters', async () => {
    const p = provider('anthropic', '', { apiKey: 'sk-ant-test', directBrowser: false });
    await p.analyze(jpeg(), 'Is there fire?', { allowedEvents: ['fire'], maxOutputTokens: 200 });
    const req = mock.requests[0]!;
    expect(req.path).toBe('/v1/messages');
    expect(req.headers['anthropic-version']).toBe('2026-10-21');
    expect(req.headers['x-api-key']).toBe('sk-ant-test');
    expect(req.headers['anthropic-dangerous-direct-browser-access']).toBeUndefined();
    expect(req.body.max_tokens).toBe(200);
    for (const k of ['temperature', 'top_p', 'top_k']) expect(req.body).not.toHaveProperty(k);
    expect(req.body.system).toMatch(/UNTRUSTED DATA/);
    const [img, text] = req.body.messages[0].content;
    expect(img).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: expect.stringMatching(/^\/9j\//) } });
    expect(text.type).toBe('text');
  });

  it('sends the direct-browser header only in direct mode', async () => {
    const p = provider('anthropic', '', { directBrowser: true });
    await p.analyze(jpeg(), 'q', { allowedEvents: ['fire'], maxOutputTokens: 100 });
    expect(mock.requests[0]!.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('computes visual token cost as ceil(w/28)*ceil(h/28)', () => {
    expect(anthropicImageTokens(512, 288)).toBe(19 * 11);
  });
});

describe('error mapping', () => {
  it.each([
    [429, 'rate-limit'],
    [500, 'server'],
    [503, 'server'],
    [401, 'auth'],
    [402, 'payment'],
    [403, 'forbidden'],
  ] as const)('HTTP %i -> %s', async (status, kind) => {
    mock.setHandler((_r, res) => json(res, status, { error: 'x' }, status === 429 ? { 'retry-after': '7' } : {}));
    const err = await provider('openai', '/v1')
      .analyze(jpeg(), 'q', { allowedEvents: ['fire'], maxOutputTokens: 100 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe(kind);
    expect((err as ProviderError).status).toBe(status);
    if (status === 429) expect((err as ProviderError).retryAfterSec).toBe(7);
  });

  it('timeout -> timeout', async () => {
    mock.setHandler(() => undefined); // never answers
    const err = await provider('openai', '/v1', { timeoutMs: 1000 })
      .analyze(jpeg(), 'q', { allowedEvents: ['fire'], maxOutputTokens: 100 })
      .catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe('timeout');
  });

  it('malformed model output -> parse (C12: never treated as none)', async () => {
    mock.setHandler((_r, res) => json(res, 200, openAiReply('Sure! I think there might be a fire.')));
    const err = await provider('openai', '/v1')
      .analyze(jpeg(), 'q', { allowedEvents: ['fire'], maxOutputTokens: 100 })
      .catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe('parse');
  });

  it('non-JSON HTTP body -> parse', async () => {
    mock.setHandler((_r, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>gateway</html>');
    });
    const err = await provider('openai', '/v1')
      .analyze(jpeg(), 'q', { allowedEvents: ['fire'], maxOutputTokens: 100 })
      .catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe('parse');
  });

  it('connection refused -> network', async () => {
    const p = createProvider({ id: 'local', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKey: null, timeoutMs: 3000, fetchFn });
    const err = await p.analyze(jpeg(), 'q', { allowedEvents: ['fire'], maxOutputTokens: 100 }).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe('network');
  });
});

describe('defensive parse (§6.1)', () => {
  it('strips code fences and leading prose, clamps and normalizes confidence', () => {
    expect(parseDetection('Here you go:\n```json\n{"event":"fire","confidence":1.7,"reason":"x"}\n```', ['fire'])).toEqual({ event: 'fire', confidence: 1, reason: 'x' });
    expect(parseDetection('{"event":"none","confidence":85,"reason":"no {braces} issue"}', ['fire']).confidence).toBe(0.85);
    expect(parseDetection('{"event":"fire","confidence":"0.4","reason":""}', ['fire']).confidence).toBe(0.4);
  });

  it('takes the first JSON object only', () => {
    expect(parseDetection('{"event":"none","confidence":0.1,"reason":"a"} {"event":"fire","confidence":1,"reason":"b"}', ['fire']).event).toBe('none');
  });

  it('rejects unknown events, missing fields and empty output', () => {
    expect(() => parseDetection('{"event":"unlock_door","confidence":1,"reason":""}', ['fire'])).toThrow(ProviderError);
    expect(() => parseDetection('{"confidence":1}', ['fire'])).toThrow(ProviderError);
    expect(() => parseDetection('', ['fire'])).toThrow(ProviderError);
  });
});

describe('probe (C26)', () => {
  it('renders a valid 512 x 256 PNG with anti-aliased, 24 px tall characters', () => {
    const png = renderProbeImage('ACEF34');
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset);
    const { width, height } = PROBE_LAYOUT;
    expect([width, height]).toEqual([512, 256]);
    expect(view.getUint32(16)).toBe(width);
    expect(view.getUint32(20)).toBe(height);
    const idatLen = view.getUint32(33);
    const raw = inflateSync(Buffer.from(png.slice(41, 41 + idatLen)));
    expect(raw.length).toBe((width + 1) * height);
    const px = [...raw].filter((_, i) => i % (width + 1) !== 0); // minus filter bytes
    const dark = px.filter((b) => b < 128).length;
    const grey = px.filter((b) => b > 0 && b < 255).length;
    expect(dark).toBeGreaterThan(800);
    expect(grey).toBeGreaterThan(200); // smooth edges, not blocky pixels
    // Ink only in the band of the characters: 24 px tall plus the stroke.
    const rows = Array.from({ length: height }, (_, y) => px.slice(y * width, (y + 1) * width).some((b) => b < 255));
    expect(rows.filter(Boolean).length).toBeLessThanOrEqual(24 + PROBE_LAYOUT.stroke + 2);
  });

  it('codes never repeat a character twice in a row; a reading one character off still proves sight', () => {
    for (let i = 0; i < 500; i++) {
      const c = randomProbeCode();
      expect(c).toMatch(new RegExp(`^[${PROBE_ALPHABET}]{6}$`));
      expect(c).not.toMatch(/(.)\1/);
    }
    expect(probeReadingMatches('VMAFT3', 'VMAFT3')).toBe(true);
    expect(probeReadingMatches('VMFT3', 'VMAFT3')).toBe(true); // one dropped
    expect(probeReadingMatches('VMAFFT3', 'VMAFT3')).toBe(true); // one added
    expect(probeReadingMatches('VNAFT3', 'VMAFT3')).toBe(true); // one misread
    expect(probeReadingMatches('UNAFT3', 'VMAFT3')).toBe(false); // two misread
    expect(probeReadingMatches('VMAF', 'VMAFT3')).toBe(false);
    expect(probeReadingMatches('', 'VMAFT3')).toBe(false);
    expect(probeReadingMatches(null, 'VMAFT3')).toBe(false);
  });

  it('a small vision model that drops one character passes; the result keeps what it read', async () => {
    mock.setHandler((r, res) => {
      const code = readCodeFromRequest(r.body.messages[1].content[1].image_url.url);
      json(res, 200, openAiReply(`{"code":"${code.slice(0, 2)}${code.slice(3)}"}`));
    });
    const r = await provider('local', '/v1', { apiKey: null }).probe();
    expect(r).toMatchObject({ ok: true, supportsVision: true, attempts: 1 });
    expect(r.got).toHaveLength(5);
  });

  it('a vision mock that receives the exact image passes', async () => {
    const code = 'XY3467';
    const expectedB64 = bytesToBase64(renderProbeImage(code));
    mock.setHandler((r, res) => {
      const url: string = r.body.messages[1].content[1].image_url.url;
      const sawIt = url === `data:image/png;base64,${expectedB64}`;
      json(res, 200, openAiReply(sawIt ? `{"code":"${code}"}` : '{"code":"UNKNOWN"}'));
    });
    const p = provider('local', '/v1', { apiKey: null });
    const r = await p.probe({ code });
    expect(r).toMatchObject({ ok: true, supportsVision: true, expected: code, got: code });
    expect(p.supportsVision).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('a text-only mock is refused (HTTP 200 is not proof)', async () => {
    mock.setHandler((_r, res) => json(res, 200, openAiReply("I'm a text model and cannot view images.")));
    const p = provider('deepseek', '');
    const r = await p.probe();
    expect(r.ok).toBe(false);
    expect(r.supportsVision).toBe(false);
    expect(p.supportsVision).toBe(false);
    expect(r.error).toMatch(/cannot be used as the Vision provider/);
  });

  it('a server that rejects image input is refused', async () => {
    mock.setHandler((_r, res) => json(res, 400, { error: { message: 'image input is not supported by this model' } }));
    const r = await provider('openai', '/v1').probe();
    expect(r.ok).toBe(false);
  });

  it('a misread earns one fresh code; a model that cannot see fails both; errors are not retried', async () => {
    // Reads correctly only on the second image (a real vision model misreading once).
    let calls = 0;
    mock.setHandler((r, res) => {
      calls++;
      const url: string = r.body.messages[1].content[1].image_url.url;
      json(res, 200, openAiReply(calls === 1 ? '{"code":"WRONG1"}' : `{"code":"${readCodeFromRequest(url)}"}`));
    });
    const ok = await provider('local', '/v1', { apiKey: null }).probe();
    expect(ok).toMatchObject({ ok: true, attempts: 2 });
    expect(calls).toBe(2);
    // Never sees the image: refused after two different codes.
    calls = 0;
    const codes: string[] = [];
    mock.setHandler((r, res) => {
      calls++;
      codes.push(r.body.messages[1].content[1].image_url.url);
      json(res, 200, openAiReply('{"code":"ACEFHJ"}'));
    });
    const bad = await provider('local', '/v1', { apiKey: null }).probe();
    expect(bad).toMatchObject({ ok: false, attempts: 2 });
    expect(new Set(codes).size).toBe(2);
    // A transport error is final.
    calls = 0;
    mock.setHandler((_r, res) => {
      calls++;
      json(res, 401, { error: 'bad key' });
    });
    expect(await provider('openai', '/v1').probe()).toMatchObject({ ok: false, attempts: 1 });
    expect(calls).toBe(1);
  });

  it('the alphabet has no glyph a model confuses with another (no D, O, 0, 9, G, 1, I, L, 2, Z, 5, S, 8, B)', () => {
    expect(PROBE_ALPHABET).not.toMatch(/[DO09G1IL2Z5S8B]/);
    expect(PROBE_ALPHABET.length ** 6).toBeGreaterThan(50_000_000);
  });

  it('LM Studio-style servers: a base URL without a path gets /v1, and a 200 without a completion is an error, not an empty answer', async () => {
    // LM Studio answers an unknown path with HTTP 200 and an error text instead of a 404.
    mock.setHandler((r, res) => {
      if (r.path !== '/v1/chat/completions') return json(res, 200, { error: `Unexpected endpoint or method. (POST ${r.path}). Returning 200 anyway` });
      const url: string = r.body.messages[1].content[1].image_url.url;
      json(res, 200, openAiReply(`{"code":"${readCodeFromRequest(url)}"}`));
    });
    const ok = await provider('local', '', { apiKey: null }).probe();
    expect(ok).toMatchObject({ ok: true });
    expect(mock.requests.at(-1)!.path).toBe('/v1/chat/completions');
    // A wrong path is now a clear error carrying the server's own words (openai-style bases keep their path).
    mock.setHandler((r, res) => json(res, 200, { error: `Unexpected endpoint or method. (POST ${r.path}). Returning 200 anyway` }));
    const bad = await provider('openai', '/wrong', { apiKey: 'sk-test' }).probe();
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/answered without a chat completion: "Unexpected endpoint or method/);
    await expect(provider('openai', '/wrong').analyze(new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'q', { allowedEvents: ['fire'], maxOutputTokens: 50 })).rejects.toMatchObject({ kind: 'parse' });
  });

  it('an empty answer is reported as empty, and listModels returns the ids a server serves', async () => {
    mock.setHandler((_r, res) => json(res, 200, openAiReply('')));
    const r = await provider('local', '/v1', { apiKey: null }).probe();
    expect(r.error).toMatch(/empty answer/);
    mock.setHandler((r2, res) => json(res, 200, r2.path === '/v1/models' ? { data: [{ id: 'qwen/qwen3-vl-4b' }, { id: 'google/gemma-3-4b' }] } : {}));
    const { listModels } = await import('../src');
    expect(await listModels({ id: 'local', baseUrl: mock.url, apiKey: null, fetchFn })).toEqual(['qwen/qwen3-vl-4b', 'google/gemma-3-4b']);
  });

  it('C10: Ollama 403 yields the exact OLLAMA_ORIGINS command for the OS', async () => {
    mock.setHandler((_r, res) => json(res, 403, ''));
    const r = await provider('local', '/v1', { apiKey: null }).probe({ os: 'linux', extensionOrigin: 'chrome-extension://abc' });
    expect(r.ok).toBe(false);
    expect(r.hint).toContain('Environment="OLLAMA_ORIGINS=chrome-extension://abc"');
  });
});

describe('failover chain', () => {
  it('advances on timeout, 429, 5xx, 401, malformed JSON and logs which provider answered', async () => {
    const behaviors = ['timeout', '429', '500', '401', 'garbage', 'ok'] as const;
    const servers = await Promise.all(
      behaviors.map((b) =>
        startMock((_r, res) => {
          if (b === 'timeout') return;
          if (b === '429') return json(res, 429, {});
          if (b === '500') return json(res, 500, {});
          if (b === '401') return json(res, 401, {});
          if (b === 'garbage') return json(res, 200, openAiReply('no json here'));
          return json(res, 200, openAiReply(okDetection));
        }),
      ),
    );
    try {
      const chain: ChainEntry[] = servers.map((s) => ({
        provider: createProvider({ id: 'local', baseUrl: s.url, model: 'm', apiKey: null, timeoutMs: 1000, fetchFn }),
        cloud: false,
      }));
      const out = await analyzeWithFailover(chain, jpeg(), 'q', { allowedEvents: ['fire'], maxOutputTokens: 100 });
      expect(out.result.event).toBe('fire');
      expect(out.attempts.map((a) => a.errorKind ?? a.outcome)).toEqual(['timeout', 'rate-limit', 'server', 'auth', 'parse', 'answered']);
      expect(servers.map((s) => s.requests.length)).toEqual([1, 1, 1, 1, 1, 1]);
    } finally {
      await Promise.all(servers.map((s) => s.close()));
    }
  });

  it('throws AllProvidersFailedError when every provider fails', async () => {
    mock.setHandler((_r, res) => json(res, 503, {}));
    const chain: ChainEntry[] = [{ provider: provider('openai', '/v1'), cloud: true }];
    const err = await analyzeWithFailover(chain, jpeg(), 'q', { allowedEvents: ['fire'], maxOutputTokens: 100 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect((err as AllProvidersFailedError).reason).toBe('all-providers-failed');
  });

  it('budget hook skips metered providers and labels the outcome as budget', async () => {
    const chain: ChainEntry[] = [{ provider: provider('openai', '/v1'), cloud: true }];
    const err = await analyzeWithFailover(chain, jpeg(), 'q', {
      allowedEvents: ['fire'],
      maxOutputTokens: 100,
      allowCall: (e) => !e.cloud,
    }).catch((e: unknown) => e);
    expect((err as AllProvidersFailedError).reason).toBe('budget');
    expect(mock.requests).toHaveLength(0);
  });
});

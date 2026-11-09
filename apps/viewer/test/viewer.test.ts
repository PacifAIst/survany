// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { buildSources, runLadder, type PlayerAdapter } from '../src/ladder';
import { readLink, renderMeta, sessionId } from '../src/meta';

const ID = '3f1c2a9e-8d4b-4c1a-9f2e-1b2c3d4e5f60';
const TOK = 'A'.repeat(43);

describe('SG-27 viewer-link metadata', () => {
  it('renders valid fields as text with an "unverified" label, never as markup', () => {
    const q = `?t=${TOK}&event_id=${ID}&rule=fire&severity=critical&timestamp=2026-11-09T10:11:12.000Z`;
    const { token, meta } = readLink(q);
    expect(token).toBe(TOK);
    const root = document.createElement('section');
    renderMeta(root, meta, 'unverified');
    expect(root.querySelector('.badge')?.textContent).toBe('Unverified, from this link');
    expect(root.textContent).toContain('fire');
    expect(root.textContent).toContain(ID);
  });

  it('drops malformed, oversized and HTML-bearing values', () => {
    const evil = encodeURIComponent('<img src=x onerror="window.pwned=1">');
    const { meta } = readLink(`?t=${TOK}&event_id=${evil}&rule=${evil}&severity=${evil}&timestamp=${'9'.repeat(80)}`);
    expect(meta).toEqual({});
    const root = document.createElement('section');
    renderMeta(root, { rule: '<b>bold</b>' as string }, 'unverified');
    expect(root.querySelector('b')).toBeNull(); // textContent only: even a value that slipped through is not markup
    expect(root.textContent).toContain('<b>bold</b>');
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it('switches to "verified" after the backend confirms and disappears when the token is rejected', () => {
    const root = document.createElement('section');
    renderMeta(root, { rule: 'fire' }, 'verified');
    expect(root.querySelector('.badge')?.textContent).toBe('Verified by the server');
    renderMeta(root, { rule: 'fire' }, 'rejected');
    expect(root.childNodes).toHaveLength(0);
  });

  it('rejects malformed or duplicated tokens', () => {
    expect(readLink('?t=short').token).toBeNull();
    expect(readLink(`?t=${TOK}&t=${TOK}`).token).toBeNull();
  });

  it('keeps one session id per link for reconnects', () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const a = sessionId(s, TOK);
    expect(sessionId(s, TOK)).toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
});

describe('viewer ladder (M5)', () => {
  // Yields one macrotask so a source that connects immediately beats its watchdog, as in real time.
  const instant = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

  it('WebRTC first, then LL-HLS; each source gets its own watchdog; no retry loop', async () => {
    const tried: string[] = [];
    const player: PlayerAdapter = {
      play: async (src) => {
        tried.push(src.kind);
        return new Promise<boolean>(() => undefined); // never connects: the watchdog must fire
      },
      stop: () => undefined,
    };
    const out = await runLadder(buildSources('wss://live/app/x?transport=all', 'https://live/app/x/llhls.m3u8'), player, { live: true, sleep: instant });
    expect(out).toEqual({ ok: false, tried: ['webrtc', 'llhls'] });
    expect(tried).toEqual(['webrtc', 'llhls']);
  });

  it('falls back to LL-HLS when WebRTC fails, and stops at the first success', async () => {
    const player: PlayerAdapter = { play: async (src) => src.kind === 'llhls', stop: () => undefined };
    const out = await runLadder(buildSources('wss://a', 'https://b'), player, { live: true, sleep: instant });
    expect(out).toMatchObject({ ok: true, source: { kind: 'llhls' } });
  });

  it('a viewer who arrives first waits out the 5 s start budget before trying', async () => {
    const waits: number[] = [];
    const player: PlayerAdapter = { play: async () => true, stop: () => undefined };
    await runLadder(buildSources('wss://a', null), player, {
      live: false,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(waits[0]).toBe(5000);
  });

  it('a stream admitted moments ago waits only for the rest of the budget; an older one starts at once', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      waits.push(ms);
    };
    const player: PlayerAdapter = { play: async () => true, stop: () => undefined };
    await runLadder(buildSources('wss://a', null), player, { live: true, liveForMs: 600, sleep });
    expect(waits[0]).toBe(4400);
    waits.length = 0;
    await runLadder(buildSources('wss://a', null), player, { live: true, liveForMs: 30_000, sleep });
    expect(waits[0]).toBe(10_000); // only the per-source watchdog timer, no start wait
  });
});

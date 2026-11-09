/**
 * Vision probe (C26). An HTTP 200 does not prove a model saw anything, and images under
 * 200 px cause mistakes, so the probe renders a random code into a 256 px image and the
 * model must read it back.
 */
import { bytesToBase64, randomBytes } from '@survey-anything/shared';
import type { ChatImageRequest, ChatImageResponse } from './adapter';
import { ProviderError } from './errors';
import { encodeGrayPng } from './image';
import { parseProbeCode } from './parse';
import { PROBE_SYSTEM, PROBE_USER } from './prompt';

/**
 * Unambiguous glyphs only (no 0/O, 1/I/L, 2/Z, 5/S, 8/B). D and 9 are left out too: measured on
 * qwen2.5vl:7b (2026-11-09), this font's D was read as O or 0 and its 9 as G.
 */
export const PROBE_ALPHABET = 'ACEFHJKMNPRTUVWXY3467';

// 5x7 bitmap font, one string per row, '#' = ink.
const FONT: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['#..#.', '#..#.', '#..#.', '#####', '...#.', '...#.', '...#.'],
  '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
};

export const PROBE_SIZE = 256;
export const PROBE_SCALE = 6;
/** Space between glyphs. Wide enough that a model does not merge two equal neighbours ("JJ" read as "J"). */
export const PROBE_GAP = 12;
export const PROBE_CODE_LEN = 6;
const SCALE = PROBE_SCALE;
const CODE_LEN = PROBE_CODE_LEN;

export function randomProbeCode(len = CODE_LEN): string {
  const bytes = randomBytes(len * 2);
  let s = '';
  for (let i = 0; s.length < len && i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    // Rejection sampling keeps the distribution uniform.
    if (b < 256 - (256 % PROBE_ALPHABET.length)) s += PROBE_ALPHABET[b % PROBE_ALPHABET.length];
  }
  return s.length === len ? s : randomProbeCode(len);
}

/** Renders `code` as black glyphs centered on a white 256x256 grayscale image. */
export function renderProbeImage(code: string): Uint8Array {
  const pixels = new Uint8Array(PROBE_SIZE * PROBE_SIZE).fill(255);
  const glyphW = 5 * SCALE;
  const gap = PROBE_GAP;
  const totalW = code.length * glyphW + (code.length - 1) * gap;
  const x0 = Math.floor((PROBE_SIZE - totalW) / 2);
  const y0 = Math.floor((PROBE_SIZE - 7 * SCALE) / 2);
  [...code].forEach((ch, ci) => {
    const glyph = FONT[ch];
    if (!glyph) throw new Error(`probe font has no glyph for '${ch}'`);
    glyph.forEach((row, ry) => {
      [...row].forEach((cell, rx) => {
        if (cell !== '#') return;
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) {
            const x = x0 + ci * (glyphW + gap) + rx * SCALE + dx;
            const y = y0 + ry * SCALE + dy;
            pixels[y * PROBE_SIZE + x] = 0;
          }
        }
      });
    });
  });
  return encodeGrayPng(pixels, PROBE_SIZE, PROBE_SIZE);
}

export interface ProbeOpts {
  code?: string;
  signal?: AbortSignal;
  /** Used for the Ollama 403 hint (C10). */
  os?: 'mac' | 'windows' | 'linux';
  extensionOrigin?: string;
  /**
   * Fresh codes to try when the model answers but misreads (default 2). A model that cannot see the
   * image has no realistic chance of guessing a code: 21^6 combinations per attempt. Transport errors
   * (401, 403, timeouts) are not retried.
   */
  attempts?: number;
}

export interface ProbeResult {
  ok: boolean;
  supportsVision: boolean;
  latencyMs: number;
  expected: string;
  got: string | null;
  error: string | null;
  hint: string | null;
  /** How many codes were shown before the result (1 or more). */
  attempts: number;
}

interface ChatCapable {
  readonly id: string;
  chatImage(req: ChatImageRequest): Promise<ChatImageResponse>;
}

export function ollamaOriginsHint(os: 'mac' | 'windows' | 'linux', origin: string): string {
  switch (os) {
    case 'mac':
      return `Ollama refused this extension (HTTP 403). Run:\n  launchctl setenv OLLAMA_ORIGINS "${origin}"\nthen quit and reopen Ollama.`;
    case 'windows':
      return `Ollama refused this extension (HTTP 403). In PowerShell run:\n  setx OLLAMA_ORIGINS "${origin}"\nthen quit Ollama from the tray and start it again.`;
    case 'linux':
      return `Ollama refused this extension (HTTP 403). Run:\n  sudo systemctl edit ollama.service\nadd under [Service]:\n  Environment="OLLAMA_ORIGINS=${origin}"\nthen: sudo systemctl daemon-reload && sudo systemctl restart ollama`;
  }
}

export async function runProbe(adapter: ChatCapable, opts: ProbeOpts = {}): Promise<ProbeResult> {
  const tries = opts.code ? 1 : Math.max(1, Math.min(opts.attempts ?? 2, 3));
  let last: ProbeResult | null = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    last = await probeOnce(adapter, opts, opts.code ?? randomProbeCode(), attempt);
    // Only a wrong reading earns another code; an error (auth, 403, timeout, parse) is final.
    if (last.ok || last.got === null) return last;
  }
  if (!last) throw new Error("probe made no attempt");
  return last;
}

async function probeOnce(adapter: ChatCapable, opts: ProbeOpts, expected: string, attempt: number): Promise<ProbeResult> {
  const png = renderProbeImage(expected);
  const started = Date.now();
  try {
    const out = await adapter.chatImage({
      imageB64: bytesToBase64(png),
      mime: 'image/png',
      system: PROBE_SYSTEM,
      user: PROBE_USER,
      maxOutputTokens: 60,
      structured: false,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const got = parseProbeCode(out.text);
    const ok = got === expected;
    return {
      ok,
      supportsVision: ok,
      latencyMs: Date.now() - started,
      expected,
      got,
      error: ok ? null : 'the model did not read the code in the probe image; it cannot be used as the Vision provider',
      hint: null,
      attempts: attempt,
    };
  } catch (e) {
    const err = e instanceof ProviderError ? e : null;
    const hint =
      err?.kind === 'forbidden' && adapter.id === 'local' && opts.os && opts.extensionOrigin
        ? ollamaOriginsHint(opts.os, opts.extensionOrigin)
        : null;
    return {
      ok: false,
      supportsVision: false,
      latencyMs: Date.now() - started,
      expected,
      got: null,
      error: e instanceof Error ? e.message : String(e),
      hint,
      attempts: attempt,
    };
  }
}

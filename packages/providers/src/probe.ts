// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Vision probe (C26). An HTTP 200 does not prove a model saw anything, so the probe renders a random code
 * into an image and the model must read it back.
 *
 * The glyphs are a smooth, anti-aliased stroke font (drawn here, no font files and no canvas, so the same
 * image is produced in the extension's service worker, the backend and Node). Measured 2026-11-11 on
 * qwen3-vl-4b-instruct in LM Studio: the previous blocky 5x7 pixel font was read 1 time in 10 at any size;
 * this font at 24 px on 512 x 256 was read exactly 66 times in 70 and within one character 70 times in 70.
 * Bigger characters read worse with that model (60 px: 1 in 20), so the size is deliberate.
 */
import { bytesToBase64, randomBytes } from '@survey-anything/shared';
import type { ChatImageRequest, ChatImageResponse } from './adapter';
import { ProviderError } from './errors';
import { encodeGrayPng } from './image';
import { parseProbeCode } from './parse';
import { PROBE_SYSTEM, PROBE_USER } from './prompt';

/**
 * Unambiguous glyphs only (no 0/O, 1/I/L, 2/Z, 5/S, 8/B, D/O, 9/G).
 */
export const PROBE_ALPHABET = 'ACEFHJKMNPRTUVWXY3467';

type Pt = readonly [number, number];
type Stroke = readonly Pt[];

/** Points on an elliptical arc; angles in degrees, 0 = right, 90 = down (image coordinates). */
function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number, steps = 16): Pt[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as const;
  });
}

/** Each glyph is a set of polylines in a 4 x 6 box (x right, y down). */
const FONT: Record<string, readonly Stroke[]> = {
  A: [[[0, 6], [2, 0], [4, 6]], [[0.7, 4], [3.3, 4]]],
  C: [arc(2.1, 3, 2.1, 3, 318, 42, 24)],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3.2, 3]]],
  F: [[[4, 0], [0, 0], [0, 6]], [[0, 3], [3.2, 3]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  J: [[[1.6, 0], [4, 0], [4, 4.2], ...arc(2, 4.2, 2, 1.8, 0, 180)]],
  K: [[[0, 0], [0, 6]], [[4, 0], [0, 4]], [[1.4, 2.6], [4, 6]]],
  M: [[[0, 6], [0, 0], [2, 3.6], [4, 0], [4, 6]]],
  N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
  P: [[[0, 6], [0, 0], [2.4, 0], ...arc(2.4, 1.6, 1.6, 1.6, 270, 450), [0, 3.2]]],
  R: [[[0, 6], [0, 0], [2.4, 0], ...arc(2.4, 1.6, 1.6, 1.6, 270, 450), [0, 3.2]], [[2, 3.2], [4, 6]]],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  U: [[[0, 0], [0, 4], ...arc(2, 4, 2, 2, 180, 0), [4, 0]]],
  V: [[[0, 0], [2, 6], [4, 0]]],
  W: [[[0, 0], [1, 6], [2, 1.8], [3, 6], [4, 0]]],
  X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]],
  Y: [[[0, 0], [2, 3], [4, 0]], [[2, 3], [2, 6]]],
  '3': [[[0.2, 0], [4, 0], [1.9, 2.3], ...arc(2, 4.1, 2, 1.9, 270, 505)]],
  '4': [[[3, 6], [3, 0], [0, 4.2], [4, 4.2]]],
  '6': [arc(4.4, 4.2, 4.4, 4.2, 252, 180), arc(2, 4.2, 2, 1.8, 0, 360, 32)],
  '7': [[[0, 0], [4, 0], [1.4, 6]]],
};

export interface ProbeLayout {
  width: number;
  height: number;
  /** Pixels per font unit: a glyph is 4 units wide and 6 high. */
  unit: number;
  /** Pixels between glyph boxes. */
  gap: number;
  /** Stroke width in pixels. */
  stroke: number;
}

/** 512 x 256 with 24 px tall characters (see the measurements above). */
export const PROBE_LAYOUT: ProbeLayout = { width: 512, height: 256, unit: 4, gap: 12, stroke: 4 };
export const PROBE_CODE_LEN = 6;
const CODE_LEN = PROBE_CODE_LEN;

/** Where each glyph box of a `len`-character code sits, in pixels (integers, so a glyph renders identically at any slot). */
export function probeCells(len: number, layout: ProbeLayout = PROBE_LAYOUT): { x: number; y: number; w: number; h: number }[] {
  const w = 4 * layout.unit;
  const h = 6 * layout.unit;
  const x0 = Math.floor((layout.width - (len * w + (len - 1) * layout.gap)) / 2);
  const y = Math.floor((layout.height - h) / 2);
  return Array.from({ length: len }, (_, i) => ({ x: x0 + i * (w + layout.gap), y, w, h }));
}

function distToSegment(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

/**
 * A random code with no character twice in a row: small models often merge a doubled character ("FF"
 * read as "F"), which says nothing about whether they can see.
 */
export function randomProbeCode(len = CODE_LEN): string {
  const bytes = randomBytes(len * 4);
  let s = '';
  for (let i = 0; s.length < len && i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    // Rejection sampling keeps the distribution uniform.
    if (b >= 256 - (256 % PROBE_ALPHABET.length)) continue;
    const c = PROBE_ALPHABET[b % PROBE_ALPHABET.length] ?? '';
    if (c !== s[s.length - 1]) s += c;
  }
  return s.length === len ? s : randomProbeCode(len);
}

/** Levenshtein distance, stopping early once it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...cur) > max) return max + 1;
    prev = cur;
  }
  return prev[b.length] ?? max + 1;
}

/**
 * Whether a reading proves the model saw the code: exact, or one character dropped, added or misread.
 * Small vision models see the image but are weak at reading random letters. A model that cannot see
 * still has no realistic chance: whatever it answers, at most 126 of the 67.2 million possible codes
 * (21 x 20^5) are within one character of its answer, so a guess passes one attempt with a probability
 * below 2 in a million.
 */
export function probeReadingMatches(got: string | null, expected: string): boolean {
  return got !== null && got.length > 0 && editDistance(got, expected, 1) <= 1;
}

/** Renders `code` as anti-aliased black strokes centered on a white grayscale PNG. */
export function renderProbeImage(code: string, layout: ProbeLayout = PROBE_LAYOUT): Uint8Array {
  const { width, height, unit, stroke } = layout;
  const pixels = new Uint8Array(width * height).fill(255);
  const cells = probeCells(code.length, layout);
  const first = cells[0];
  const last = cells[cells.length - 1];
  if (!first || !last || first.x < stroke || first.y < stroke || last.x + last.w + stroke > width) throw new Error('probe code does not fit the image');
  const half = stroke / 2;
  [...code].forEach((ch, ci) => {
    const glyph = FONT[ch];
    const cell = cells[ci];
    if (!glyph || !cell) throw new Error(`probe font has no glyph for '${ch}'`);
    const segs = glyph.flatMap((line) =>
      line.slice(1).map((p, i) => {
        const a = line[i] as Pt;
        return [[cell.x + a[0] * unit, cell.y + a[1] * unit], [cell.x + p[0] * unit, cell.y + p[1] * unit]] as const;
      }),
    );
    const pad = Math.ceil(half) + 1;
    for (let y = cell.y - pad; y < cell.y + cell.h + pad; y++) {
      for (let x = cell.x - pad; x < cell.x + cell.w + pad; x++) {
        let d = Infinity;
        for (const [a, b] of segs) d = Math.min(d, distToSegment(x + 0.5, y + 0.5, a, b));
        const ink = Math.max(0, Math.min(1, half + 0.5 - d));
        if (ink > 0) pixels[y * width + x] = Math.min(pixels[y * width + x] ?? 255, Math.round(255 * (1 - ink)));
      }
    }
  });
  return encodeGrayPng(pixels, width, height);
}

export interface ProbeOpts {
  code?: string;
  signal?: AbortSignal;
  /** Used for the Ollama 403 hint (C10). */
  os?: 'mac' | 'windows' | 'linux';
  extensionOrigin?: string;
  /**
   * Fresh codes to try when the model answers but misreads (default 2). A model that cannot see the
   * image has no realistic chance of guessing a code (see probeReadingMatches). Transport errors
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
  /** The model id the server reported for its answer, when it reported one. */
  servedModel?: string | null;
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
    const ok = probeReadingMatches(got, expected);
    if (!ok && out.text.trim() === '') {
      return {
        ok: false,
        supportsVision: false,
        latencyMs: Date.now() - started,
        expected,
        got: null,
        error: 'the model returned an empty answer: is the model loaded, and does it accept images?',
        hint: null,
        attempts: attempt,
      };
    }
    return {
      ok,
      supportsVision: ok,
      latencyMs: Date.now() - started,
      expected,
      got,
      error: ok ? null : 'the model did not read the code in the probe image; it cannot be used as the Vision provider',
      hint: null,
      attempts: attempt,
      servedModel: out.model ?? null,
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

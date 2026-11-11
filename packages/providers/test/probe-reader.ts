// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Reads the code back out of the C26 probe PNG by comparing each glyph cell with the probe font. Used by
 * the unit tests and by the e2e model mock (apps/extension/e2e/model-mock.ts) to play a model that sees.
 */
import { inflateSync } from 'node:zlib';
import { PROBE_ALPHABET, PROBE_CODE_LEN, PROBE_LAYOUT, probeCells, renderProbeImage } from '../src/probe';

/** Decodes an 8-bit grayscale PNG with filter 0 rows (what encodeGrayPng writes) into raw pixels. */
export function decodeGray(png: Uint8Array): { width: number; height: number; px: Uint8Array } {
  const b = Buffer.from(png);
  let off = 8;
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('latin1', off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    if (raw[y * (width + 1)] !== 0) throw new Error('unexpected PNG filter');
    px.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return { width, height, px };
}

let refCache: { c: string; img: Uint8Array }[] | null = null;

/** Reads the code out of the extension's probe PNG by comparing each glyph cell with the probe font. */
export function readProbeCode(png: Uint8Array): string {
  const { width, height, px } = decodeGray(png);
  if (width !== PROBE_LAYOUT.width || height !== PROBE_LAYOUT.height) throw new Error(`unexpected probe size ${width}x${height}`);
  const len = PROBE_CODE_LEN;
  // A reference image per character, with that character in every slot (the renderer allows repeats).
  refCache ??= [...PROBE_ALPHABET].map((c) => ({ c, img: decodeGray(renderProbeImage(c.repeat(len))).px }));
  const refs = refCache;
  let code = '';
  probeCells(len).forEach((cell, i) => {
    const match = refs.find(({ img }) => {
      for (let y = cell.y; y < cell.y + cell.h; y++) {
        for (let x = cell.x; x < cell.x + cell.w; x++) if (img[y * width + x] !== px[y * width + x]) return false;
      }
      return true;
    });
    if (!match) throw new Error(`probe glyph ${i} matches no character`);
    code += match.c;
  });
  return code;
}

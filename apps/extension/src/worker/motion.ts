// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/** Motion filter (§4.3 step 1, §6.3 `motion` gate). Works on small grayscale frames. */
import type { Region } from '@survey-anything/recipes';

export const ANALYSIS_W = 96;
export const ANALYSIS_H = 72;

export interface Gray {
  data: Uint8Array;
  width: number;
  height: number;
}

export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Gray {
  const data = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    // ITU-R BT.601 luma, integer approximation.
    data[i] = ((rgba[p] ?? 0) * 77 + (rgba[p + 1] ?? 0) * 150 + (rgba[p + 2] ?? 0) * 29) >> 8;
  }
  return { data, width, height };
}

export function regionBounds(width: number, height: number, region?: Region): { x0: number; y0: number; x1: number; y1: number } {
  if (!region) return { x0: 0, y0: 0, x1: width, y1: height };
  const x0 = Math.max(0, Math.floor(region.x * width));
  const y0 = Math.max(0, Math.floor(region.y * height));
  const x1 = Math.min(width, Math.ceil((region.x + region.w) * width));
  const y1 = Math.min(height, Math.ceil((region.y + region.h) * height));
  return { x0, y0, x1: Math.max(x1, x0 + 1), y1: Math.max(y1, y0 + 1) };
}

/** Fraction of pixels in `region` whose luma changed by more than `pixelDelta`. */
export function changedFraction(prev: Gray, cur: Gray, pixelDelta: number, region?: Region): number {
  if (prev.width !== cur.width || prev.height !== cur.height) return 1;
  const { x0, y0, x1, y1 } = regionBounds(cur.width, cur.height, region);
  let changed = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * cur.width;
    for (let x = x0; x < x1; x++) {
      total++;
      if (Math.abs((cur.data[row + x] ?? 0) - (prev.data[row + x] ?? 0)) > pixelDelta) changed++;
    }
  }
  return total === 0 ? 0 : changed / total;
}

export function meanLuma(g: Gray): number {
  let s = 0;
  for (const v of g.data) s += v;
  return g.data.length === 0 ? 0 : s / g.data.length;
}

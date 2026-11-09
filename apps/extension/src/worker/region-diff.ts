// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `region-diff` gate (§6.3): change or color shift inside a drawn region, compared with the
 * reference frame captured at arm time. Also hosts the interim flame heuristic (§6.3, logged
 * as a known limitation until the D-Fire weights are trained).
 */
import type { Region } from '@survey-anything/recipes';
import { changedFraction, type Gray, regionBounds } from './motion';

export type TargetColor = 'red' | 'green' | 'blue' | 'yellow' | 'orange';

export interface Rgba {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** Hue in degrees [0, 360), saturation and value in [0, 1]. */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max / 255];
}

export function matchesColor(r: number, g: number, b: number, color: TargetColor): boolean {
  const [h, s, v] = rgbToHsv(r, g, b);
  if (s < 0.45 || v < 0.35) return false;
  switch (color) {
    case 'red':
      return h < 15 || h >= 345;
    case 'orange':
      return h >= 15 && h < 40;
    case 'yellow':
      return h >= 40 && h < 70;
    case 'green':
      return h >= 75 && h < 165;
    case 'blue':
      return h >= 190 && h < 260;
  }
}

export function colorFraction(img: Rgba, color: TargetColor, region?: Region): number {
  const { x0, y0, x1, y1 } = regionBounds(img.width, img.height, region);
  let hit = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * img.width + x) * 4;
      total++;
      if (matchesColor(img.data[p] ?? 0, img.data[p + 1] ?? 0, img.data[p + 2] ?? 0, color)) hit++;
    }
  }
  return total === 0 ? 0 : hit / total;
}

export interface RegionDiffParams {
  region: Region;
  mode: 'any-change' | 'color-shift';
  targetColor?: TargetColor;
  threshold: number;
}

/** Returns the score compared against `threshold`: changed fraction, or the increase in target-color fraction. */
export function regionDiffScore(p: RegionDiffParams, ref: { gray: Gray; rgba: Rgba }, cur: { gray: Gray; rgba: Rgba }): number {
  if (p.mode === 'any-change') return changedFraction(ref.gray, cur.gray, 30, p.region);
  const color = p.targetColor ?? 'red';
  return colorFraction(cur.rgba, color, p.region) - colorFraction(ref.rgba, color, p.region);
}

/** Flame-colored: bright, red-dominant, warm hue, saturated. */
export function isFlamePixel(r: number, g: number, b: number): boolean {
  if (r < 180 || r <= g || g <= b) return false;
  const [h, s] = rgbToHsv(r, g, b);
  return h < 55 && s > 0.35 && r - b > 70;
}

export interface FlameScore {
  flameFraction: number;
  flicker: number;
  /** Pseudo-confidence in [0, 1] for comparison with minConfidence. */
  confidence: number;
}

/**
 * Interim fire gate: flame-colored pixels that also flicker between consecutive frames.
 * A static orange object scores low flicker; a screen showing fire still passes (the
 * confirm prompt tells the model to ignore screens).
 */
export function flameScore(prev: Rgba | null, cur: Rgba): FlameScore {
  let flame = 0;
  let flickering = 0;
  const n = cur.width * cur.height;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = cur.data[p] ?? 0;
    const g = cur.data[p + 1] ?? 0;
    const b = cur.data[p + 2] ?? 0;
    if (!isFlamePixel(r, g, b)) continue;
    flame++;
    if (prev) {
      const d = Math.abs(r - (prev.data[p] ?? 0)) + Math.abs(g - (prev.data[p + 1] ?? 0)) + Math.abs(b - (prev.data[p + 2] ?? 0));
      if (d > 45) flickering++;
    }
  }
  const flameFraction = n === 0 ? 0 : flame / n;
  const flicker = flame === 0 ? 0 : flickering / flame;
  const area = Math.min(1, flameFraction / 0.01); // 1% of the frame saturates
  const confidence = flameFraction < 0.002 ? 0 : Math.min(1, 0.5 * area + 0.5 * Math.min(1, flicker / 0.3));
  return { flameFraction, flicker, confidence };
}

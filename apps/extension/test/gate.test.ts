// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { builtinRecipe, type Recipe } from '@survey-anything/recipes';
import { evaluateGate, HitWindow, type FrameAnalysis, type NormalizedDetection } from '../src/worker/gate';
import { changedFraction, rgbaToGray, ANALYSIS_H, ANALYSIS_W } from '../src/worker/motion';
import { colorFraction, flameScore, matchesColor } from '../src/worker/region-diff';
import { TickRecorder } from '../src/worker/tick-stats';

function solid(r: number, g: number, b: number, w = ANALYSIS_W, h = ANALYSIS_H): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set([r, g, b, 255], i * 4);
  return d;
}

function frame(rgba: Uint8ClampedArray, dets: Record<string, NormalizedDetection[]> = {}, missing: string[] = []): FrameAnalysis {
  return {
    gray: rgbaToGray(rgba, ANALYSIS_W, ANALYSIS_H),
    rgba: { data: rgba, width: ANALYSIS_W, height: ANALYSIS_H },
    detections: new Map(Object.entries(dets)),
    missingModels: new Set(missing),
  };
}

const det = (label: string, score: number, cx = 0.5, cy = 0.5): NormalizedDetection => ({ label, score, cx, cy, w: 0.1, h: 0.2 });

describe('N-of-M window (§4.3 step 2)', () => {
  it('rises at minHits of the last M frames and falls only when the window is empty', () => {
    const w = new HitWindow(2, 3);
    expect([true, false, true, true, false, false, false].map((h) => w.push(h))).toEqual([null, null, 'rise', null, null, null, 'fall']);
  });

  it('a single noisy hit never rises', () => {
    const w = new HitWindow(2, 3);
    expect([true, false, false, true, false, false].map((h) => w.push(h)).filter(Boolean)).toEqual([]);
  });
});

describe('gates', () => {
  it('motion gate fires on pixel change above threshold', () => {
    const r = builtinRecipe('other')!;
    const a = frame(solid(10, 10, 10));
    const b = frame(solid(200, 200, 200));
    expect(evaluateGate(r, b, { prev: { gray: a.gray, rgba: a.rgba }, ref: null, minYoloConfidence: 0.6 }).hit).toBe(true);
    expect(evaluateGate(r, a, { prev: { gray: a.gray, rgba: a.rgba }, ref: null, minYoloConfidence: 0.6 }).hit).toBe(false);
  });

  it('region-diff color-shift fires when the region turns red (dashboard recipe)', () => {
    const r = builtinRecipe('dashboard-turns-red')!;
    const ref = frame(solid(30, 160, 60));
    const red = frame(solid(220, 20, 20));
    const g = evaluateGate(r, red, { prev: null, ref: { gray: ref.gray, rgba: ref.rgba }, minYoloConfidence: 0.6 });
    expect(g.hit).toBe(true);
    expect(g.via).toBe('region-diff');
  });

  it('detector gate respects requireClasses, requireMotion, minCount, region and confidence', () => {
    const robbery = builtinRecipe('robbery')!;
    const still = frame(solid(50, 50, 50), { 'yolox-tiny-coco': [det('person', 0.9)] });
    const ctxStill = { prev: { gray: still.gray, rgba: still.rgba }, ref: null, minYoloConfidence: 0.6 };
    expect(evaluateGate(robbery, still, ctxStill).hit).toBe(false); // person but no motion
    const moved = frame(solid(200, 200, 200), { 'yolox-tiny-coco': [det('person', 0.9), det('knife', 0.7)] });
    const g = evaluateGate(robbery, moved, ctxStill);
    expect(g.hit).toBe(true);
    expect(g.labels.sort()).toEqual(['knife', 'person']);
    const knifeOnly = frame(solid(200, 200, 200), { 'yolox-tiny-coco': [det('knife', 0.9)] });
    expect(evaluateGate(robbery, knifeOnly, ctxStill).hit).toBe(false);

    const queue = builtinRecipe('queue-too-long')!;
    const five = frame(solid(1, 1, 1), { 'yolox-tiny-coco': Array.from({ length: 5 }, () => det('person', 0.8)) });
    const six = frame(solid(1, 1, 1), { 'yolox-tiny-coco': Array.from({ length: 6 }, () => det('person', 0.8)) });
    expect(evaluateGate(queue, five, ctxStill).hit).toBe(false);
    expect(evaluateGate(queue, six, ctxStill).hit).toBe(true);

    const zone = builtinRecipe('person-in-restricted-zone')!; // region x 0.5..1
    expect(evaluateGate(zone, frame(solid(1, 1, 1), { 'yolox-tiny-coco': [det('person', 0.9, 0.2)] }), ctxStill).hit).toBe(false);
    expect(evaluateGate(zone, frame(solid(1, 1, 1), { 'yolox-tiny-coco': [det('person', 0.9, 0.8)] }), ctxStill).hit).toBe(true);
    expect(evaluateGate(zone, frame(solid(1, 1, 1), { 'yolox-tiny-coco': [det('person', 0.55, 0.8)] }), ctxStill).hit).toBe(false);
  });

  it('"Person left the camera view": hits only while nobody is seen, and the window alerts once per absence', () => {
    const left = builtinRecipe('person-left')!;
    expect(left.gate).toMatchObject({ type: 'detector', classes: ['person'], absent: true });
    const ctx = { prev: null, ref: null, minYoloConfidence: 0.6 };
    const seen = frame(solid(1, 1, 1), { 'yolox-tiny-coco': [det('person', 0.9)] });
    const empty = frame(solid(1, 1, 1), { 'yolox-tiny-coco': [] });
    // The rule's own 0.4 applies, not the global 0.6: a backlit person at 0.45 still counts as there.
    const backlit = frame(solid(1, 1, 1), { 'yolox-tiny-coco': [det('person', 0.45)] });
    const weak = frame(solid(1, 1, 1), { 'yolox-tiny-coco': [det('person', 0.3)] }); // below 0.4: not seen
    const chairOnly = frame(solid(1, 1, 1), { 'yolox-tiny-coco': [det('chair', 0.9)] });
    expect(evaluateGate(left, seen, ctx).hit).toBe(false);
    expect(evaluateGate(left, empty, ctx)).toMatchObject({ hit: true, score: 1, labels: ['no person'] });
    expect(evaluateGate(left, backlit, ctx).hit).toBe(false);
    expect(evaluateGate(left, weak, ctx).hit).toBe(true);
    expect(evaluateGate(left, chairOnly, ctx).hit).toBe(true);
    // The model did not run (or its weights are missing): never "nobody there".
    expect(evaluateGate(left, frame(solid(1, 1, 1)), ctx).hit).toBe(false);
    expect(evaluateGate(left, frame(solid(1, 1, 1), {}, ['yolox-tiny-coco']), ctx).hit).toBe(false);
    // With a region, a person outside it counts as gone.
    const atDesk = { ...left, gate: { ...left.gate, region: { x: 0, y: 0, w: 0.5, h: 1 } } } as Recipe;
    expect(evaluateGate(atDesk, frame(solid(1, 1, 1), { 'yolox-tiny-coco': [det('person', 0.9, 0.2)] }), ctx).hit).toBe(false);
    expect(evaluateGate(atDesk, frame(solid(1, 1, 1), { 'yolox-tiny-coco': [det('person', 0.9, 0.8)] }), ctx).hit).toBe(true);
    // Sit, leave (alert once), stay away (no repeat), come back (clears), leave again (alerts again).
    const w = new HitWindow(2, 3);
    const seq = [seen, seen, empty, empty, empty, empty, seen, seen, seen, empty, empty].map((f) => w.push(evaluateGate(left, f, ctx).hit));
    expect(seq).toEqual([null, null, null, 'rise', null, null, null, null, 'fall', null, 'rise']);
  });

  it('fire falls back to the interim flame heuristic when its weights are missing (§6.3)', () => {
    const fire = builtinRecipe('fire')!;
    const prev = frame(solid(250, 120, 20));
    const flicker = solid(250, 120, 20);
    for (let i = 0; i < flicker.length; i += 8) flicker.set([255, 200, 60, 255], i); // half the flame pixels shift
    const g = evaluateGate(fire, frame(flicker, {}, ['fire-smoke-yolox-tiny']), { prev: { gray: prev.gray, rgba: prev.rgba }, ref: null, minYoloConfidence: 0.6 });
    expect(g.via).toBe('flame-heuristic');
    expect(g.hit).toBe(true);
    // A static orange wall does not flicker and stays below threshold.
    const wall = frame(solid(250, 120, 20), {}, ['fire-smoke-yolox-tiny']);
    expect(evaluateGate(fire, wall, { prev: { gray: wall.gray, rgba: wall.rgba }, ref: null, minYoloConfidence: 0.6 }).hit).toBe(false);
    expect(flameScore(null, { data: solid(20, 60, 200), width: ANALYSIS_W, height: ANALYSIS_H }).flameFraction).toBe(0);
  });

  it('sampled gates never fire from pixels', () => {
    const r = builtinRecipe('water-leak')!;
    const f = frame(solid(1, 1, 1));
    expect(evaluateGate(r, f, { prev: null, ref: null, minYoloConfidence: 0.6 }).hit).toBe(false);
  });

  it('colour classification and change fraction', () => {
    expect(matchesColor(230, 20, 25, 'red')).toBe(true);
    expect(matchesColor(20, 200, 40, 'green')).toBe(true);
    expect(matchesColor(128, 128, 128, 'red')).toBe(false);
    const half = solid(0, 0, 0);
    for (let i = 0; i < half.length / 2; i += 4) half.set([255, 0, 0, 255], i);
    expect(colorFraction({ data: half, width: ANALYSIS_W, height: ANALYSIS_H }, 'red')).toBeCloseTo(0.5, 2);
    const a = rgbaToGray(solid(0, 0, 0), ANALYSIS_W, ANALYSIS_H);
    const b = rgbaToGray(half, ANALYSIS_W, ANALYSIS_H);
    expect(changedFraction(a, b, 25)).toBeCloseTo(0.5, 2);
    expect(changedFraction(a, b, 25, { x: 0, y: 0.5, w: 1, h: 0.5 })).toBe(0);
  });

  it('unused recipe type check compiles', () => {
    const r: Recipe | undefined = builtinRecipe('door-left-open');
    expect(r?.gate.type).toBe('region-diff');
  });
});

describe('tick recorder (M1 soak metric)', () => {
  it('counts intervals within ±1 s and the longest consecutive miss', () => {
    const t = new TickRecorder(5000);
    [0, 5000, 10200, 15000, 25000, 30000].forEach((x) => t.tick(x));
    const s = t.snapshot();
    expect(s.ticks).toBe(6);
    expect(s.withinOneSecond).toBe(4);
    expect(s.maxGapMs).toBe(10000);
    expect(s.maxConsecutiveMissed).toBe(1);
    expect(s.gapsOver2x).toBe(0);
  });
});

describe('region outline geometry', () => {
  it('maps a fractional region to pixels inside its cell, keeping the stroke visible at the frame edge', async () => {
    const { outlineRect } = await import('../src/worker/outline');
    const r = outlineRect({ x: 0.5, y: 0, w: 0.5, h: 1 }, 0, 0, 512, 288);
    expect(r.lineWidth).toBe(2);
    expect(r.x).toBe(256);
    expect(r.y).toBe(1); // half the stroke inside the top edge
    expect(r.x + r.w).toBe(511);
    expect(r.y + r.h).toBe(287);
    // A montage cell: same region, offset into the second column.
    const c = outlineRect({ x: 0.3, y: 0.1, w: 0.4, h: 0.8 }, 256, 0, 256, 144);
    expect(c.x).toBeCloseTo(256 + 0.3 * 256);
    expect(c.w).toBeCloseTo(0.4 * 256);
  });
});

// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-rule gate evaluation and the N-of-M window (§4.3 steps 1-2). Pure logic, unit-tested.
 * The worker feeds it one analysis frame per tick; the service worker owns the rest of the
 * state machine (§6.4).
 */
import type { Gate, Recipe } from '@survey-anything/recipes';
import { changedFraction, type Gray } from './motion';
import { flameScore, regionDiffScore, type Rgba } from './region-diff';
import type { Detection } from './yolox-decode';

export interface FrameAnalysis {
  gray: Gray;
  rgba: Rgba;
  /** Detections in normalized [0,1] coordinates, by model id. Absent when the model did not run. */
  detections: Map<string, NormalizedDetection[]>;
  /** Models whose weights are missing and must use their fallback. */
  missingModels: ReadonlySet<string>;
}

export interface NormalizedDetection {
  label: string;
  score: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export interface GateHit {
  hit: boolean;
  score: number;
  labels: string[];
  via: 'detector' | 'flame-heuristic' | 'motion' | 'region-diff' | 'sampled';
}

export interface GateContext {
  prev: { gray: Gray; rgba: Rgba } | null;
  ref: { gray: Gray; rgba: Rgba } | null;
  minYoloConfidence: number;
}

function inRegion(d: NormalizedDetection, gate: Extract<Gate, { type: 'detector' }>): boolean {
  const r = gate.region;
  if (!r) return true;
  return d.cx >= r.x && d.cx <= r.x + r.w && d.cy >= r.y && d.cy <= r.y + r.h;
}

export function evaluateGate(recipe: Recipe, frame: FrameAnalysis, ctx: GateContext): GateHit {
  const gate = recipe.gate;
  switch (gate.type) {
    case 'detector': {
      // An absence rule never fires on a model that did not run: "nothing seen" would be meaningless.
      if (gate.absent && (frame.missingModels.has(gate.model) || !frame.detections.has(gate.model))) return { hit: false, score: 0, labels: [], via: 'detector' };
      if (frame.missingModels.has(gate.model)) {
        // §6.3 interim fire gate: motion plus flame-color heuristic.
        const s = flameScore(ctx.prev?.rgba ?? null, frame.rgba);
        const thr = Math.max(gate.minConfidence, ctx.minYoloConfidence);
        return { hit: s.confidence >= thr, score: s.confidence, labels: s.confidence > 0 ? ['fire?'] : [], via: 'flame-heuristic' };
      }
      const all = frame.detections.get(gate.model) ?? [];
      // The global minimum guards against false "someone is there" candidates. For an absence rule a weak
      // detection must still count as "there" (a backlit person at a desk scores lower), so it uses its own.
      const thr = gate.absent ? gate.minConfidence : Math.max(gate.minConfidence, ctx.minYoloConfidence);
      const wanted = new Set(gate.classes);
      const dets = all.filter((d) => wanted.has(d.label) && d.score >= thr && inRegion(d, gate));
      const labels = [...new Set(dets.map((d) => d.label))];
      const required = gate.requireClasses ?? [];
      const haveRequired = required.every((c) => labels.includes(c));
      const countOk = gate.minCount === undefined || dets.length >= gate.minCount;
      let motionOk = true;
      if (gate.requireMotion) motionOk = ctx.prev ? changedFraction(ctx.prev.gray, frame.gray, 25) >= 0.01 : false;
      const top = dets.reduce((m, d) => Math.max(m, d.score), 0);
      if (gate.absent) {
        // "Someone left": hit while fewer than minCount (default 1) of the classes are seen in the region.
        const present = dets.length >= (gate.minCount ?? 1) && haveRequired;
        return { hit: !present, score: present ? 0 : 1 - top, labels: present ? [] : gate.classes.map((c) => `no ${c}`), via: 'detector' };
      }
      return { hit: dets.length > 0 && haveRequired && countOk && motionOk, score: top, labels, via: 'detector' };
    }
    case 'motion': {
      if (!ctx.prev) return { hit: false, score: 0, labels: [], via: 'motion' };
      const f = changedFraction(ctx.prev.gray, frame.gray, gate.pixelDelta, gate.region);
      return { hit: f >= gate.threshold, score: f, labels: [], via: 'motion' };
    }
    case 'region-diff': {
      if (!ctx.ref) return { hit: false, score: 0, labels: [], via: 'region-diff' };
      const s = regionDiffScore(gate, ctx.ref, { gray: frame.gray, rgba: frame.rgba });
      return { hit: s >= gate.threshold, score: s, labels: [], via: 'region-diff' };
    }
    case 'sampled':
      return { hit: false, score: 0, labels: [], via: 'sampled' };
  }
}

export type WindowTransition = 'rise' | 'fall' | null;

/** N-of-M hits with hysteresis: rises at >= minHits in the last M frames, falls at zero hits. */
export class HitWindow {
  private readonly buf: boolean[] = [];
  private hot = false;

  constructor(
    private readonly minHits: number,
    private readonly windowFrames: number,
  ) {}

  push(hit: boolean): WindowTransition {
    this.buf.push(hit);
    if (this.buf.length > this.windowFrames) this.buf.shift();
    const hits = this.buf.filter(Boolean).length;
    if (!this.hot && hits >= this.minHits) {
      this.hot = true;
      return 'rise';
    }
    if (this.hot && hits === 0 && this.buf.length >= Math.min(this.windowFrames, this.minHits)) {
      this.hot = false;
      return 'fall';
    }
    return null;
  }

  get isHot(): boolean {
    return this.hot;
  }
}

/** Maps a raw detection list in source pixels to normalized detections. */
export function normalizeDetections(dets: Detection[], labels: readonly string[], frameW: number, frameH: number): NormalizedDetection[] {
  return dets.map((d) => ({
    label: labels[d.classId] ?? `class-${d.classId}`,
    score: d.score,
    cx: (d.x1 + d.x2) / 2 / frameW,
    cy: (d.y1 + d.y2) / 2 / frameH,
    w: (d.x2 - d.x1) / frameW,
    h: (d.y2 - d.y1) / frameH,
  }));
}

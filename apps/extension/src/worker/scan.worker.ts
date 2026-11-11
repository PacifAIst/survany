// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Scan loop (C1): driven by a self-correcting timer in this dedicated Worker, never by chrome.alarms.
 * Per tick: grab the latest frame, run the motion filter, the needed detectors, then each rule's gate
 * and its N-of-M window. Rising edges become candidates for the service worker to confirm.
 */
import { DETECTOR_MODELS, outlineRegion, type Recipe, type Region } from '@survey-anything/recipes';
import { drawOutline, outlineRect } from './outline';
import { type ChecksumEntry, ChecksumMismatchError, configureOrt, Detector, loadVerifiedAsset } from './detector';
import { evaluateGate, HitWindow, normalizeDetections, type NormalizedDetection } from './gate';
import { ANALYSIS_H, ANALYSIS_W, changedFraction, type Gray, meanLuma, rgbaToGray } from './motion';
import type { MainToWorker, ScanSetup, TickStats, WorkerToMain } from './protocol';
import type { Rgba } from './region-diff';
import { TickRecorder } from './tick-stats';
import { blobToB64 } from './detector';

/** Narrow view of the dedicated worker global (the DOM and WebWorker libs cannot be combined). */
const ctx = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<MainToWorker>) => void) | null;
};

const STILL_HOT_EVERY_MS = 60_000;
const DETECTOR_EVERY_N_TICKS_WITHOUT_MOTION = 6;
const FROZEN_AFTER_MS = 60_000;
const BLACK_LUMA = 4;
const BLACK_AFTER_TICKS = 6;

let setup: ScanSetup | null = null;
let assetBase = '';
let checksums: ChecksumEntry[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let nextAt = 0;
let stopped = true;
let recorder = new TickRecorder(5000);
let startedAt = Date.now();

// Frame sources: a MediaStreamTrackProcessor stream (preferred) or bitmaps posted by the main thread.
let latestFrame: VideoFrame | null = null;
let latestFrameAt: number | null = null;
let lastFrameTimestamp: number | null = null;
let lastFrameTimestampChangedAt = Date.now();
let usingProcessor = false;
let pendingBitmap: ((b: ImageBitmap | null) => void) | null = null;

// Analysis state.
const analysisCanvas = new OffscreenCanvas(ANALYSIS_W, ANALYSIS_H);
const snapCanvas = new OffscreenCanvas(1, 1);
let prev: { gray: Gray; rgba: Rgba } | null = null;
let ref: { gray: Gray; rgba: Rgba } | null = null;
const windows = new Map<string, HitWindow>();
const hotSince = new Map<string, number>();
const lastStillHot = new Map<string, number>();
const nextSampleAt = new Map<string, number>();
const ring: ImageBitmap[] = [];
let ticksSinceDetector = DETECTOR_EVERY_N_TICKS_WITHOUT_MOTION;
let blackTicks = 0;
let healthState: 'ok' | 'frozen' | 'black' | 'no-frames' = 'ok';

// Detectors by model id.
const detectors = new Map<string, Detector>();
const missingModels = new Set<string>();
let detectorState: TickStats['detector'] = 'none';

function post(msg: WorkerToMain, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

function log(level: 'info' | 'warn' | 'error', msg: string): void {
  post({ type: 'log', level, msg });
}

async function loadDetectors(s: ScanSetup): Promise<void> {
  const needed = new Set(s.recipes.flatMap((r) => (r.gate.type === 'detector' ? [r.gate.model] : [])));
  if (needed.size === 0) return;
  detectorState = 'loading';
  configureOrt(assetBase);
  for (const id of needed) {
    if (detectors.has(id) || missingModels.has(id)) continue;
    const info = DETECTOR_MODELS[id];
    if (!info) continue;
    try {
      const bytes = await loadVerifiedAsset(info.file, assetBase, checksums);
      const det = await Detector.create(bytes, info.classes.length, s.preferWebGPU, log);
      detectors.set(id, det);
      log('info', `detector ${id} ready on ${det.provider} (${det.inputW}x${det.inputH})`);
    } catch (e) {
      if (e instanceof ChecksumMismatchError && !/not listed/.test(e.message)) {
        // A tampered or corrupted model is never used.
        log('error', e.message);
      }
      missingModels.add(id);
      log('warn', `detector ${id} unavailable (${e instanceof Error ? e.message : String(e)}); ${info.fallback === 'flame-heuristic' ? 'interim flame heuristic active' : 'its rules cannot fire'}`);
    }
  }
  const first = [...detectors.values()][0];
  detectorState = first ? first.provider : 'none';
}

function resetRuleState(s: ScanSetup): void {
  windows.clear();
  hotSince.clear();
  lastStillHot.clear();
  nextSampleAt.clear();
  const now = Date.now();
  for (const r of s.recipes) {
    windows.set(r.id, new HitWindow(s.minHits, s.windowFrames));
    if (r.gate.type === 'sampled') nextSampleAt.set(r.id, now + r.gate.everyMinutes * 60_000);
  }
}

async function pumpFrames(readable: ReadableStream<VideoFrame>): Promise<void> {
  usingProcessor = true;
  const reader = readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      latestFrame?.close();
      latestFrame = value;
      latestFrameAt = Date.now();
      if (value.timestamp !== lastFrameTimestamp) {
        lastFrameTimestamp = value.timestamp;
        lastFrameTimestampChangedAt = latestFrameAt;
      }
    }
  } catch (e) {
    log('warn', `frame stream ended: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    usingProcessor = false;
  }
}

async function requestBitmap(): Promise<ImageBitmap | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      pendingBitmap = null;
      resolve(null);
    }, 2000);
    pendingBitmap = (b) => {
      clearTimeout(t);
      pendingBitmap = null;
      resolve(b);
    };
    post({ type: 'need-frame' });
  });
}

async function acquireFrame(): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void } | null> {
  if (usingProcessor) {
    const f = latestFrame;
    if (!f) return null;
    // Clone so the pump can close its copy independently.
    const c = f.clone();
    return { source: c, width: c.displayWidth, height: c.displayHeight, release: () => c.close() };
  }
  const b = await requestBitmap();
  if (!b) return null;
  latestFrameAt = Date.now();
  lastFrameTimestampChangedAt = latestFrameAt;
  return { source: b, width: b.width, height: b.height, release: () => b.close() };
}

function analyze(source: CanvasImageSource): { gray: Gray; rgba: Rgba } {
  const ctx = analysisCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D context unavailable');
  ctx.drawImage(source, 0, 0, ANALYSIS_W, ANALYSIS_H);
  const data = ctx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H).data;
  return { gray: rgbaToGray(data, ANALYSIS_W, ANALYSIS_H), rgba: { data, width: ANALYSIS_W, height: ANALYSIS_H } };
}

function pushRing(source: CanvasImageSource, w: number, h: number, maxPx: number): void {
  const scale = Math.min(1, maxPx / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const c = new OffscreenCanvas(tw, th);
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(source, 0, 0, tw, th);
  ring.push(c.transferToImageBitmap());
  while (ring.length > 4) ring.shift()?.close();
}

async function encodeJpeg(frames: ImageBitmap[], quality: number, maxPx: number, region: Region | null): Promise<string> {
  const last = frames[frames.length - 1];
  if (!last) throw new Error('no frame to encode');
  if (frames.length === 1) {
    snapCanvas.width = last.width;
    snapCanvas.height = last.height;
    const ctx = snapCanvas.getContext('2d');
    ctx?.drawImage(last, 0, 0);
    if (ctx && region) drawOutline(ctx, outlineRect(region, 0, 0, last.width, last.height));
  } else {
    // §6.3 montage: 2 frames side by side, 3-4 frames in a 2x2 grid, time order left-right, top-bottom.
    const cols = 2;
    const rows = frames.length <= 2 ? 1 : 2;
    const cellW = Math.floor(maxPx / cols);
    const cellH = Math.round((cellW * last.height) / last.width);
    snapCanvas.width = cellW * cols;
    snapCanvas.height = cellH * rows;
    const ctx = snapCanvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, snapCanvas.width, snapCanvas.height);
    frames.forEach((f, i) => {
      const x0 = (i % cols) * cellW;
      const y0 = Math.floor(i / cols) * cellH;
      ctx.drawImage(f, x0, y0, cellW, cellH);
      if (region) drawOutline(ctx, outlineRect(region, x0, y0, cellW, cellH));
    });
  }
  return blobToB64(await snapCanvas.convertToBlob({ type: 'image/jpeg', quality }));
}

async function emitCandidate(kind: 'candidate' | 'still-hot', r: Recipe, gate: { score: number; labels: string[]; via: string }, s: ScanSetup): Promise<void> {
  const n = Math.min(r.confirm.framesPerCheck, ring.length);
  if (n === 0) return;
  const frames = ring.slice(-n);
  // The rule's region is outlined so the model (and the person reading the alert) can see where it applies.
  const region = outlineRegion(r);
  const confirmImageB64 = await encodeJpeg(frames, s.jpegQuality, s.downscaleMaxPx, region);
  const snapshotB64 = n === 1 ? confirmImageB64 : await encodeJpeg(frames.slice(-1), s.jpegQuality, s.downscaleMaxPx, region);
  post({ type: kind, rule: r.id, confirmImageB64, snapshotB64, framesPerCheck: n, gate });
}

function setHealth(state: typeof healthState): void {
  if (state === healthState) return;
  healthState = state;
  post({ type: 'source-health', state });
}

async function tick(): Promise<void> {
  const s = setup;
  if (!s) return;
  const now = Date.now();
  recorder.tick(now);
  const frame = await acquireFrame();
  if (!frame) {
    if (latestFrameAt === null || now - latestFrameAt > FROZEN_AFTER_MS) setHealth('no-frames');
    return;
  }
  try {
    const cur = analyze(frame.source);
    pushRing(frame.source, frame.width, frame.height, s.downscaleMaxPx);
    ref ??= cur;

    // Source health (§10: frozen or black frames).
    blackTicks = meanLuma(cur.gray) < BLACK_LUMA ? blackTicks + 1 : 0;
    if (blackTicks >= BLACK_AFTER_TICKS) setHealth('black');
    else if (usingProcessor && now - lastFrameTimestampChangedAt > FROZEN_AFTER_MS) setHealth('frozen');
    else setHealth('ok');

    // Motion pre-filter decides whether detectors run this tick.
    const motion = prev ? changedFraction(prev.gray, cur.gray, 25) : 1;
    ticksSinceDetector++;
    const detections = new Map<string, NormalizedDetection[]>();
    // An absence rule ("someone left") needs a fresh look every tick: an empty room is also a still one.
    const watchesAbsence = s.recipes.some((r) => r.gate.type === 'detector' && r.gate.absent === true);
    if (detectors.size > 0 && (watchesAbsence || motion >= 0.002 || ticksSinceDetector >= DETECTOR_EVERY_N_TICKS_WITHOUT_MOTION)) {
      ticksSinceDetector = 0;
      for (const [id, det] of detectors) {
        const info = DETECTOR_MODELS[id];
        if (!info) continue;
        try {
          const raw = await det.detect(frame.source, frame.width, frame.height, Math.min(0.25, s.minYoloConfidence));
          detections.set(id, normalizeDetections(raw, info.classes, frame.width, frame.height));
        } catch (e) {
          log('warn', `detector ${id} failed this tick: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    const analysis = { gray: cur.gray, rgba: cur.rgba, detections, missingModels };
    for (const r of s.recipes) {
      if (r.gate.type === 'sampled') {
        const due = nextSampleAt.get(r.id) ?? 0;
        if (now >= due) {
          nextSampleAt.set(r.id, now + r.gate.everyMinutes * 60_000);
          post({ type: 'clear', rule: r.id });
          await emitCandidate('candidate', r, { score: 1, labels: [], via: 'sampled' }, s);
        }
        continue;
      }
      // A detector rule whose model never ran this tick keeps its window unchanged.
      if (r.gate.type === 'detector' && !missingModels.has(r.gate.model) && !detections.has(r.gate.model)) continue;
      const g = evaluateGate(r, analysis, { prev, ref, minYoloConfidence: s.minYoloConfidence });
      const w = windows.get(r.id);
      if (!w) continue;
      const t = w.push(g.hit);
      if (t === 'rise') {
        hotSince.set(r.id, now);
        lastStillHot.set(r.id, now);
        await emitCandidate('candidate', r, g, s);
      } else if (t === 'fall') {
        hotSince.delete(r.id);
        post({ type: 'clear', rule: r.id });
      } else if (w.isHot && now - (lastStillHot.get(r.id) ?? now) >= STILL_HOT_EVERY_MS) {
        lastStillHot.set(r.id, now);
        await emitCandidate('still-hot', r, g, s);
      }
    }
    prev = cur;
  } finally {
    frame.release();
  }
}

function schedule(): void {
  if (stopped || !setup) return;
  const interval = setup.intervalMs;
  const delay = Math.max(0, nextAt - performance.now());
  timer = setTimeout(() => {
    const started = performance.now();
    nextAt += interval;
    // After a long stall, re-anchor instead of firing a burst of catch-up ticks.
    if (started - nextAt > interval) nextAt = started + interval;
    tick()
      .catch((e: unknown) => log('error', `tick failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(schedule);
  }, delay);
}

function start(s: ScanSetup): void {
  setup = s;
  stopped = false;
  recorder = new TickRecorder(s.intervalMs);
  startedAt = Date.now();
  resetRuleState(s);
  nextAt = performance.now() + s.intervalMs;
  if (timer) clearTimeout(timer);
  schedule();
}

function stats(): TickStats {
  const snap = recorder.snapshot();
  return {
    ...snap,
    intervalMs: setup?.intervalMs ?? 0,
    startedAt,
    detector: detectorState,
    missingModels: [...missingModels],
    lastFrameAt: latestFrameAt,
  };
}

ctx.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'init':
      assetBase = m.assetBase;
      checksums = m.checksums;
      start(m.setup);
      void loadDetectors(m.setup);
      break;
    case 'update':
      start(m.setup);
      void loadDetectors(m.setup);
      break;
    case 'frames':
      void pumpFrames(m.readable);
      break;
    case 'frame':
      if (pendingBitmap) pendingBitmap(m.bitmap);
      else m.bitmap.close();
      break;
    case 'no-frame':
      pendingBitmap?.(null);
      break;
    case 'stats':
      post({ type: 'stats', id: m.id, stats: stats() });
      break;
    case 'stop':
      stopped = true;
      if (timer) clearTimeout(timer);
      latestFrame?.close();
      latestFrame = null;
      for (const b of ring.splice(0)) b.close();
      prev = null;
      ref = null;
      break;
  }
};

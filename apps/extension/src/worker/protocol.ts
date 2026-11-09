// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/** Messages between the offscreen document's main thread and the scan Worker. */
import type { Recipe } from '@survey-anything/recipes';
import type { ChecksumEntry, ExecutionProvider } from './detector';

export interface ScanSetup {
  intervalMs: number;
  recipes: Recipe[];
  minYoloConfidence: number;
  minHits: number;
  windowFrames: number;
  downscaleMaxPx: number;
  jpegQuality: number;
  preferWebGPU: boolean;
}

export interface GateInfo {
  score: number;
  labels: string[];
  via: string;
}

export interface TickStats {
  ticks: number;
  intervalMs: number;
  startedAt: number;
  lastTickAt: number | null;
  withinOneSecond: number;
  fractionWithinOneSecond: number;
  maxGapMs: number;
  gapsOver2x: number;
  maxConsecutiveMissed: number;
  detector: ExecutionProvider | 'none' | 'loading';
  missingModels: string[];
  lastFrameAt: number | null;
}

export type MainToWorker =
  | { type: 'init'; assetBase: string; checksums: ChecksumEntry[]; setup: ScanSetup }
  | { type: 'frames'; readable: ReadableStream<VideoFrame> }
  | { type: 'frame'; bitmap: ImageBitmap; capturedAt: number }
  | { type: 'no-frame' }
  | { type: 'update'; setup: ScanSetup }
  | { type: 'stats'; id: number }
  | { type: 'stop' };

export type CandidateKind = 'candidate' | 'still-hot';

export type WorkerToMain =
  | { type: 'need-frame' }
  | {
      type: CandidateKind;
      rule: string;
      confirmImageB64: string;
      snapshotB64: string;
      framesPerCheck: number;
      gate: GateInfo;
    }
  | { type: 'clear'; rule: string }
  | { type: 'source-health'; state: 'ok' | 'frozen' | 'black' | 'no-frames' }
  | { type: 'stats'; id: number; stats: TickStats }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string };

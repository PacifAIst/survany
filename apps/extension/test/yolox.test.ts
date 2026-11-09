// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * M2 acceptance: decode and NMS match the Python reference within 2 px and 0.02 score.
 * The raw output fixture comes from the real bundled model (scripts/gen-yolox-fixture.ts);
 * the expected detections come from models/reference/yolox_reference.py (Megvii's algorithm).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COCO_CLASSES } from '@survey-anything/recipes';
import { nms } from '../src/worker/nms';
import { decodeYolox, scaleDetections, yoloxGrids } from '../src/worker/yolox-decode';

const repo = join(__dirname, '..', '..', '..');
const raw = JSON.parse(readFileSync(join(repo, 'bench', 'fixtures', 'yolox_tiny_dog.raw.json'), 'utf8')) as {
  inputW: number;
  inputH: number;
  numClasses: number;
  numAnchors: number;
  ratio: number;
  anchors: { index: number; values: number[] }[];
};
const py = JSON.parse(readFileSync(join(repo, 'bench', 'fixtures', 'yolox_tiny_dog.python.json'), 'utf8')) as {
  scoreThr: number;
  nmsThr: number;
  detections: { x1: number; y1: number; x2: number; y2: number; score: number; classId: number }[];
};

function fullTensor(): Float32Array {
  const t = new Float32Array(raw.numAnchors * (5 + raw.numClasses));
  for (const a of raw.anchors) t.set(a.values, a.index * (5 + raw.numClasses));
  return t;
}

describe('YOLOX decode + NMS vs Python reference (M2)', () => {
  it('grid layout matches 416x416 strides 8/16/32', () => {
    expect(yoloxGrids(416, 416).count).toBe(52 * 52 + 26 * 26 + 13 * 13);
    expect(raw.numAnchors).toBe(3549);
  });

  it('matches every reference detection within 2 px and 0.02 score', () => {
    const ts = nms(scaleDetections(decodeYolox(fullTensor(), raw.numClasses, raw.inputW, raw.inputH, py.scoreThr), raw.ratio), py.nmsThr);
    expect(ts).toHaveLength(py.detections.length);
    expect(py.detections.length).toBeGreaterThanOrEqual(3);
    ts.forEach((d, i) => {
      const r = py.detections[i]!;
      expect(d.classId).toBe(r.classId);
      expect(Math.abs(d.score - r.score)).toBeLessThanOrEqual(0.02);
      for (const k of ['x1', 'y1', 'x2', 'y2'] as const) expect(Math.abs(d[k] - r[k])).toBeLessThanOrEqual(2);
    });
  });

  it('finds the bicycle, the vehicle and the animal in the reference image', () => {
    const labels = py.detections.filter((d) => d.score > 0.5).map((d) => COCO_CLASSES[d.classId]);
    expect(labels).toEqual(expect.arrayContaining(['bicycle', 'car']));
    expect(labels.some((l) => l === 'dog' || l === 'cat')).toBe(true);
  });

  it('rejects an output tensor of the wrong length', () => {
    expect(() => decodeYolox(new Float32Array(10), 80, 416, 416, 0.1)).toThrow(/does not match/);
  });
});

const modelPath = join(__dirname, '..', 'public', 'models', 'yolox_tiny.onnx');

describe.skipIf(!existsSync(modelPath))('real model run in Node (WASM backend, CPU fallback)', () => {
  it('re-running the bundled model reproduces the fixture anchors', async () => {
    const { runYolox } = await import('../scripts/gen-yolox-fixture');
    const r = await runYolox(join(repo, 'bench', 'fixtures', 'dog.jpg'), modelPath);
    const dim = 85;
    let maxDiff = 0;
    for (const a of raw.anchors) {
      for (let k = 0; k < dim; k++) maxDiff = Math.max(maxDiff, Math.abs((r.output[a.index * dim + k] ?? 0) - (a.values[k] ?? 0)));
    }
    expect(maxDiff).toBeLessThan(1e-3);
  });
});

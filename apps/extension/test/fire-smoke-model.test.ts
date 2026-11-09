/**
 * M2: the fire/smoke model the extension ships, run through the extension's own JavaScript path
 * (jpeg-js decode, letterbox, ORT WASM, decodeYolox, NMS) on three CC0 D-Fire test images.
 * The reference is models/fire-smoke/gen_fixture.py (OpenCV + onnxruntime + the evaluator's decode).
 * These are clear cases on purpose: the test proves the JS path matches the Python path the benchmark
 * numbers were measured with. Accuracy itself is in docs/BENCHMARKS.md.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DETECTOR_MODELS } from '@survey-anything/recipes';
import { nms } from '../src/worker/nms';
import { decodeYolox, scaleDetections } from '../src/worker/yolox-decode';

const repo = join(__dirname, '..', '..', '..');
const fixtures = join(repo, 'bench', 'fixtures', 'dfire');
const info = DETECTOR_MODELS['fire-smoke-yolox-tiny']!;
const modelPath = join(__dirname, '..', 'public', info.file);

type Box = [number, number, number, number];
const ref = JSON.parse(readFileSync(join(fixtures, 'fire_smoke_dfire.python.json'), 'utf8')) as {
  scoreThr: number;
  nmsThr: number;
  images: { kind: 'fire' | 'smoke' | 'none'; file: string; groundTruth: { label: string; box: Box }[]; pythonDetections: { label: string; score: number; box: Box }[] }[];
};

function iou(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = w * h;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}

describe.skipIf(!existsSync(modelPath))('shipped fire/smoke model in the extension path (M2)', () => {
  const minConfidence = 0.6; // packages/recipes/recipes/fire.watch.json

  for (const img of ref.images) {
    it(`${img.kind}: ${img.file}`, async () => {
      const { runYolox } = await import('../scripts/gen-yolox-fixture');
      const r = await runYolox(join(fixtures, img.file), modelPath);
      expect(r.output.length).toBe(3549 * (5 + info.classes.length));
      const dets = nms(scaleDetections(decodeYolox(r.output, info.classes.length, r.inputSize, r.inputSize, ref.scoreThr), r.ratio), ref.nmsThr).map((d) => ({
        label: info.classes[d.classId],
        score: d.score,
        box: [d.x1, d.y1, d.x2, d.y2] as Box,
      }));

      // Same detections as the Python path: same labels, scores within 0.03, boxes overlapping at IoU >= 0.9.
      // (jpeg-js and libjpeg-turbo decode a few pixel values differently, so exact equality is not expected.)
      expect(dets.map((d) => d.label)).toEqual(img.pythonDetections.map((d) => d.label));
      dets.forEach((d, i) => {
        const p = img.pythonDetections[i]!;
        expect(Math.abs(d.score - p.score)).toBeLessThanOrEqual(0.03);
        expect(iou(d.box, p.box)).toBeGreaterThanOrEqual(0.9);
      });

      // And what the fire gate would decide on this frame.
      const firing = dets.filter((d) => d.score >= minConfidence);
      if (img.kind === 'none') {
        expect(firing).toEqual([]);
      } else {
        const gt = img.groundTruth[0]!;
        expect(firing.some((d) => d.label === img.kind && iou(d.box, gt.box) >= 0.5)).toBe(true);
      }
    }, 60_000);
  }
});

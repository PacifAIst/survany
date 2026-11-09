#!/usr/bin/env node
// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * M2 reference fixture: runs the bundled YOLOX-tiny on bench/fixtures/dog.jpg (from the YOLOX repo,
 * Apache-2.0) with ORT, and stores the raw output anchors that could pass the score threshold.
 * models/reference/yolox_reference.py then decodes them with Megvii's algorithm, and the Vitest
 * suite compares the TypeScript decode + NMS against that Python output.
 */
import { createRequire } from 'node:module';
import type * as OrtNs from 'onnxruntime-web';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const repoRoot = join(appRoot, '..', '..');
const require = createRequire(join(appRoot, 'package.json'));
const jpeg = require('jpeg-js') as { decode(b: Buffer, o: { useTArray: boolean }): { width: number; height: number; data: Uint8Array } };
const ort = require('onnxruntime-web') as typeof OrtNs;

export const STORE_THR = 0.01;

/** Bilinear resize with OpenCV's half-pixel convention, RGBA in, RGBA out. */
function resizeBilinear(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  const sx = sw / dw;
  const sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), sh - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, sh - 1);
    const wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), sw - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, sw - 1);
      const wx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = src[(y0 * sw + x0) * 4 + c] ?? 0;
        const b = src[(y0 * sw + x1) * 4 + c] ?? 0;
        const d = src[(y1 * sw + x0) * 4 + c] ?? 0;
        const e = src[(y1 * sw + x1) * 4 + c] ?? 0;
        out[(y * dw + x) * 4 + c] = Math.round((a * (1 - wx) + b * wx) * (1 - wy) + (d * (1 - wx) + e * wx) * wy);
      }
    }
  }
  return out;
}

export function letterboxBgrChw(rgba: Uint8Array, w: number, h: number, size: number): { data: Float32Array; ratio: number } {
  const ratio = Math.min(size / w, size / h);
  const rw = Math.floor(w * ratio);
  const rh = Math.floor(h * ratio);
  const resized = resizeBilinear(rgba, w, h, rw, rh);
  const plane = size * size;
  const data = new Float32Array(3 * plane).fill(114);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const p = (y * rw + x) * 4;
      const i = y * size + x;
      data[i] = resized[p + 2] ?? 0;
      data[plane + i] = resized[p + 1] ?? 0;
      data[2 * plane + i] = resized[p] ?? 0;
    }
  }
  return { data, ratio };
}

export async function runYolox(imagePath: string, modelPath: string): Promise<{ output: Float32Array; ratio: number; width: number; height: number; inputSize: number }> {
  ort.env.wasm.numThreads = 1; // multi-threaded WASM hangs under Node; the extension also uses 1 thread
  const img = jpeg.decode(readFileSync(imagePath), { useTArray: true });
  const session = await ort.InferenceSession.create(modelPath);
  const inputSize = 416;
  const { data, ratio } = letterboxBgrChw(img.data, img.width, img.height, inputSize);
  const out = await session.run({ images: new ort.Tensor('float32', data, [1, 3, inputSize, inputSize]) });
  const t = out['output'];
  if (!t) throw new Error('no output');
  return { output: t.data as Float32Array, ratio, width: img.width, height: img.height, inputSize };
}

async function main(): Promise<void> {
  const r = await runYolox(join(repoRoot, 'bench', 'fixtures', 'dog.jpg'), join(appRoot, 'public', 'models', 'yolox_tiny.onnx'));
  const dim = 85;
  const anchors: { index: number; values: number[] }[] = [];
  for (let a = 0; a < r.output.length / dim; a++) {
    if ((r.output[a * dim + 4] ?? 0) >= STORE_THR) anchors.push({ index: a, values: Array.from(r.output.slice(a * dim, (a + 1) * dim)) });
  }
  const fixture = { model: 'yolox_tiny.onnx', image: 'dog.jpg', inputW: r.inputSize, inputH: r.inputSize, numClasses: 80, numAnchors: r.output.length / dim, ratio: r.ratio, storeThr: STORE_THR, anchors };
  writeFileSync(join(repoRoot, 'bench', 'fixtures', 'yolox_tiny_dog.raw.json'), JSON.stringify(fixture));
  console.info(`wrote ${anchors.length} anchors (obj >= ${STORE_THR}) of ${fixture.numAnchors}`);
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();

// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * YOLOX through onnxruntime-web inside the dedicated Worker (§4.1): WebGPU first, then WASM.
 * SECURITY-GATE SG-26: models and WASM load only from the extension package and are checked against bundled SHA-256 sums before use.
 */
import * as ort from 'onnxruntime-web';
import { bytesToBase64 } from '@survey-anything/shared';
import { fetchBundledAsset } from '../sw/guarded-fetch';
import { nms } from './nms';
import { decodeYolox, type Detection, scaleDetections } from './yolox-decode';

export interface ChecksumEntry {
  name: string;
  path: string;
  sha256: string;
  license: string;
}

export type ExecutionProvider = 'webgpu' | 'wasm';

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ChecksumMismatchError extends Error {}

export async function loadVerifiedAsset(path: string, base: string, checksums: readonly ChecksumEntry[]): Promise<ArrayBuffer> {
  const entry = checksums.find((c) => c.path === path);
  if (!entry) throw new ChecksumMismatchError(`${path} is not listed in checksums.json`);
  const buf = await fetchBundledAsset(new URL(path, base).href, base);
  const got = await sha256Hex(buf);
  if (got !== entry.sha256) throw new ChecksumMismatchError(`${path}: sha256 ${got} does not match ${entry.sha256}`);
  return buf;
}

export function configureOrt(assetBase: string): void {
  ort.env.wasm.wasmPaths = new URL('ort/', assetBase).href;
  ort.env.wasm.numThreads = 1; // offscreen documents are not cross-origin isolated; threads would need SharedArrayBuffer
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'warning';
}

/** Letterbox into an input-size canvas filled with 114, BGR CHW float32, as Megvii's preproc does. */
export function letterboxToTensor(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  inputW: number,
  inputH: number,
  canvas: OffscreenCanvas,
): { data: Float32Array; ratio: number } {
  const ratio = Math.min(inputW / srcW, inputH / srcH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D context unavailable');
  canvas.width = inputW;
  canvas.height = inputH;
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, inputW, inputH);
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(source, 0, 0, Math.floor(srcW * ratio), Math.floor(srcH * ratio));
  const rgba = ctx.getImageData(0, 0, inputW, inputH).data;
  return { data: rgbaToBgrChw(rgba, inputW, inputH), ratio };
}

export function rgbaToBgrChw(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Float32Array {
  const plane = w * h;
  const out = new Float32Array(3 * plane);
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    out[i] = rgba[p + 2] ?? 0; // B
    out[plane + i] = rgba[p + 1] ?? 0; // G
    out[2 * plane + i] = rgba[p] ?? 0; // R
  }
  return out;
}

export interface DetectorLog {
  (level: 'info' | 'warn', msg: string): void;
}

export class Detector {
  private constructor(
    private session: ort.InferenceSession,
    public provider: ExecutionProvider,
    private readonly modelBytes: Uint8Array,
    public readonly inputW: number,
    public readonly inputH: number,
    public readonly numClasses: number,
    private readonly log: DetectorLog,
  ) {}

  private readonly canvas = new OffscreenCanvas(1, 1);
  private recreating: Promise<void> | null = null;

  static async create(modelBytes: ArrayBuffer, numClasses: number, preferWebGPU: boolean, log: DetectorLog): Promise<Detector> {
    const bytes = new Uint8Array(modelBytes);
    let provider: ExecutionProvider = 'wasm';
    let session: ort.InferenceSession | null = null;
    if (preferWebGPU && 'gpu' in navigator) {
      try {
        session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
        provider = 'webgpu';
      } catch (e) {
        log('warn', `WebGPU unavailable, using WASM: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    session ??= await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    const meta = session.inputMetadata[0];
    const shape = meta && 'shape' in meta && Array.isArray(meta.shape) ? meta.shape : [1, 3, 416, 416];
    const inputH = typeof shape[2] === 'number' ? shape[2] : 416;
    const inputW = typeof shape[3] === 'number' ? shape[3] : 416;
    const det = new Detector(session, provider, bytes, inputW, inputH, numClasses, log);
    if (provider === 'webgpu') det.watchDeviceLoss();
    return det;
  }

  /** §10 "WebGPU device lost": fall back to WASM and log. */
  private watchDeviceLoss(): void {
    const device = (ort.env.webgpu as { device?: { lost?: Promise<{ message?: string }> } }).device;
    void device?.lost?.then((info) => {
      this.log('warn', `WebGPU device lost (${info?.message ?? 'no reason'}); falling back to WASM`);
      void this.fallbackToWasm();
    });
  }

  async fallbackToWasm(): Promise<void> {
    if (this.provider === 'wasm') return;
    this.recreating ??= (async () => {
      const s = await ort.InferenceSession.create(this.modelBytes, { executionProviders: ['wasm'] });
      this.session = s;
      this.provider = 'wasm';
      this.recreating = null;
    })();
    await this.recreating;
  }

  async detect(source: CanvasImageSource, srcW: number, srcH: number, scoreThr: number): Promise<Detection[]> {
    if (this.recreating) await this.recreating;
    const { data, ratio } = letterboxToTensor(source, srcW, srcH, this.inputW, this.inputH, this.canvas);
    const input = new ort.Tensor('float32', data, [1, 3, this.inputH, this.inputW]);
    let out: ort.InferenceSession.OnnxValueMapType;
    try {
      out = await this.session.run({ [this.session.inputNames[0] ?? 'images']: input });
    } catch (e) {
      if (this.provider === 'webgpu') {
        this.log('warn', `WebGPU inference failed, retrying on WASM: ${e instanceof Error ? e.message : String(e)}`);
        await this.fallbackToWasm();
        out = await this.session.run({ [this.session.inputNames[0] ?? 'images']: input });
      } else {
        throw e;
      }
    }
    const tensor = out[this.session.outputNames[0] ?? 'output'];
    if (!tensor) throw new Error('model produced no output');
    const raw = (await tensor.getData()) as Float32Array;
    // Same order as Megvii's onnx_inference.py: decode, divide by the letterbox ratio, then NMS.
    return nms(scaleDetections(decodeYolox(raw, this.numClasses, this.inputW, this.inputH, scoreThr), ratio));
  }
}

export async function blobToB64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/**
 * YOLOX output decoding, mirroring Megvii's demo_postprocess (YOLOX/yolox/utils/demo_utils.py).
 * The published ONNX outputs [1, N, 5 + C]: raw grid offsets (cx, cy), log sizes (w, h), and
 * already-sigmoided objectness and class scores. Anchors iterate stride 8, 16, 32, each row-major.
 */

export interface Detection {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
  classId: number;
}

export interface GridInfo {
  gx: Int32Array;
  gy: Int32Array;
  stride: Int32Array;
  count: number;
}

const gridCache = new Map<string, GridInfo>();

export function yoloxGrids(inputW: number, inputH: number, strides: readonly number[] = [8, 16, 32]): GridInfo {
  const key = `${inputW}x${inputH}:${strides.join(',')}`;
  const cached = gridCache.get(key);
  if (cached) return cached;
  let count = 0;
  for (const s of strides) count += Math.floor(inputH / s) * Math.floor(inputW / s);
  const gx = new Int32Array(count);
  const gy = new Int32Array(count);
  const stride = new Int32Array(count);
  let i = 0;
  for (const s of strides) {
    const hs = Math.floor(inputH / s);
    const ws = Math.floor(inputW / s);
    for (let y = 0; y < hs; y++) {
      for (let x = 0; x < ws; x++) {
        gx[i] = x;
        gy[i] = y;
        stride[i] = s;
        i++;
      }
    }
  }
  const info = { gx, gy, stride, count };
  gridCache.set(key, info);
  return info;
}

/**
 * Decodes raw output into boxes in input-pixel coordinates (xyxy), keeping those with
 * obj * max(cls) above `scoreThr`. Divide by the letterbox ratio to map to the source frame.
 */
export function decodeYolox(
  output: Float32Array,
  numClasses: number,
  inputW: number,
  inputH: number,
  scoreThr: number,
): Detection[] {
  const grid = yoloxGrids(inputW, inputH);
  const dim = 5 + numClasses;
  if (output.length !== grid.count * dim) {
    throw new Error(`YOLOX output length ${output.length} does not match ${grid.count} anchors x ${dim}`);
  }
  const out: Detection[] = [];
  for (let a = 0; a < grid.count; a++) {
    const base = a * dim;
    const obj = output[base + 4] ?? 0;
    if (obj < scoreThr) continue; // max(cls) <= 1, so obj bounds the score
    let best = 0;
    let bestId = 0;
    for (let c = 0; c < numClasses; c++) {
      const v = output[base + 5 + c] ?? 0;
      if (v > best) {
        best = v;
        bestId = c;
      }
    }
    const score = obj * best;
    if (score <= scoreThr) continue;
    const s = grid.stride[a] ?? 8;
    const cx = ((output[base] ?? 0) + (grid.gx[a] ?? 0)) * s;
    const cy = ((output[base + 1] ?? 0) + (grid.gy[a] ?? 0)) * s;
    const w = Math.exp(output[base + 2] ?? 0) * s;
    const h = Math.exp(output[base + 3] ?? 0) * s;
    out.push({ x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2, score, classId: bestId });
  }
  return out;
}

export function scaleDetections(dets: Detection[], ratio: number): Detection[] {
  return dets.map((d) => ({ ...d, x1: d.x1 / ratio, y1: d.y1 / ratio, x2: d.x2 / ratio, y2: d.y2 / ratio }));
}

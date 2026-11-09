/**
 * Class-agnostic NMS, matching Megvii's demo_utils.nms (which uses the +1 pixel area convention).
 */
import type { Detection } from './yolox-decode';

export function nms(dets: readonly Detection[], iouThr = 0.45): Detection[] {
  const order = [...dets].sort((a, b) => b.score - a.score);
  const keep: Detection[] = [];
  const suppressed = new Uint8Array(order.length);
  for (let i = 0; i < order.length; i++) {
    if (suppressed[i]) continue;
    const a = order[i];
    if (!a) continue;
    keep.push(a);
    const areaA = (a.x2 - a.x1 + 1) * (a.y2 - a.y1 + 1);
    for (let j = i + 1; j < order.length; j++) {
      if (suppressed[j]) continue;
      const b = order[j];
      if (!b) continue;
      const w = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) + 1);
      const h = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) + 1);
      const inter = w * h;
      const areaB = (b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1);
      if (inter / (areaA + areaB - inter) > iouThr) suppressed[j] = 1;
    }
  }
  return keep;
}

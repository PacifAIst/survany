"""
Evaluate the exported fire/smoke ONNX on the official D-Fire test split (PLAN M2, §9 false positives).

Two views of the same file the extension ships:
  1. COCO mAP (pycocotools), class-aware NMS, conf 0.001: comparable with YOLOX's own evaluator.
  2. Gate view: what the `fire` recipe sees per frame. The extension decodes, runs class-agnostic NMS
     (Megvii demo_utils) and fires when any fire/smoke box reaches the score threshold. Reported per
     threshold as recall on fire/smoke images and false-alarm rate on D-Fire's "none" images.

Preprocessing matches the extension: letterbox to 416 on a 114 pad, BGR, 0-255, no normalization.
"""

import argparse
import json
import math
import os
import time

import cv2
import numpy as np
import onnxruntime as ort
from pycocotools.coco import COCO
from pycocotools.cocoeval import COCOeval

STRIDES = (8, 16, 32)


def grids(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    gs, ss = [], []
    for s in STRIDES:
        hs, ws = h // s, w // s
        xv, yv = np.meshgrid(np.arange(ws), np.arange(hs))
        gs.append(np.stack((xv, yv), 2).reshape(-1, 2))
        ss.append(np.full((hs * ws, 1), s))
    return np.concatenate(gs), np.concatenate(ss)


def nms(boxes: np.ndarray, scores: np.ndarray, thr: float) -> list[int]:
    x1, y1, x2, y2 = boxes.T
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0.0, xx2 - xx1 + 1) * np.maximum(0.0, yy2 - yy1 + 1)
        ovr = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[np.where(ovr <= thr)[0] + 1]
    return keep


def letterbox(img: np.ndarray, size: int) -> tuple[np.ndarray, float]:
    r = min(size / img.shape[0], size / img.shape[1])
    resized = cv2.resize(img, (int(img.shape[1] * r), int(img.shape[0] * r)), interpolation=cv2.INTER_LINEAR)
    padded = np.full((size, size, 3), 114, dtype=np.uint8)
    padded[: resized.shape[0], : resized.shape[1]] = resized
    return np.ascontiguousarray(padded.transpose(2, 0, 1), dtype=np.float32)[None], r


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--data", default="/data/dfire")
    ap.add_argument("--out", required=True)
    ap.add_argument("--thresholds", default="0.25,0.4,0.5,0.6")
    args = ap.parse_args()

    sess = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0]
    size = int(inp.shape[2])
    grid, stride = grids(size, size)
    gt = COCO(os.path.join(args.data, "annotations", "test.json"))
    cat_ids = sorted(gt.getCatIds())  # 1 fire, 2 smoke
    thresholds = [float(t) for t in args.thresholds.split(",")]

    coco_dets = []
    image_rows = []
    t0 = time.time()
    for img_id in gt.getImgIds():
        info = gt.loadImgs(img_id)[0]
        img = cv2.imread(os.path.join(args.data, "test2017", info["file_name"]))
        x, r = letterbox(img, size)
        out = sess.run(None, {inp.name: x})[0][0]
        out[:, :2] = (out[:, :2] + grid) * stride
        out[:, 2:4] = np.exp(out[:, 2:4]) * stride
        boxes = np.empty((out.shape[0], 4), dtype=np.float32)
        boxes[:, 0] = out[:, 0] - out[:, 2] / 2
        boxes[:, 1] = out[:, 1] - out[:, 3] / 2
        boxes[:, 2] = out[:, 0] + out[:, 2] / 2
        boxes[:, 3] = out[:, 1] + out[:, 3] / 2
        boxes /= r
        scores = out[:, 4:5] * out[:, 5:]
        # 1) COCO view: class-aware NMS at conf 0.001.
        for c in range(scores.shape[1]):
            m = scores[:, c] > 0.001
            if not m.any():
                continue
            b, s = boxes[m], scores[m, c]
            for k in nms(b, s, 0.65):
                x1, y1, x2, y2 = b[k]
                coco_dets.append({"image_id": img_id, "category_id": cat_ids[c], "bbox": [float(x1), float(y1), float(x2 - x1), float(y2 - y1)], "score": float(s[k])})
        # 2) Gate view: class-agnostic NMS as in the extension; keep the best score per class.
        cls = scores.argmax(1)
        best = scores.max(1)
        m = best > 0.1
        kept = nms(boxes[m], best[m], 0.45) if m.any() else []
        kept_cls = cls[m][kept] if kept else np.array([], dtype=int)
        kept_scores = best[m][kept] if kept else np.array([])
        anns = gt.loadAnns(gt.getAnnIds(imgIds=img_id))
        has_fire = any(a["category_id"] == 1 for a in anns)
        has_smoke = any(a["category_id"] == 2 for a in anns)
        image_rows.append({
            "fire": has_fire,
            "smoke": has_smoke,
            "max_any": float(kept_scores.max()) if len(kept_scores) else 0.0,
            "max_fire": float(kept_scores[kept_cls == 0].max()) if (kept_cls == 0).any() else 0.0,
            "max_smoke": float(kept_scores[kept_cls == 1].max()) if (kept_cls == 1).any() else 0.0,
            "public": info["file_name"].startswith("PublicDataset"),
        })
    elapsed = time.time() - t0

    dt = gt.loadRes(coco_dets) if coco_dets else None
    coco = {}
    if dt is not None:
        for label, ids in (("all", cat_ids), ("fire", [1]), ("smoke", [2])):
            ev = COCOeval(gt, dt, "bbox")
            ev.params.catIds = ids
            ev.evaluate()
            ev.accumulate()
            ev.summarize()
            coco[label] = {"mAP50_95": float(ev.stats[0]), "mAP50": float(ev.stats[1])}

    def rate(num: int, den: int) -> float | None:
        return None if den == 0 else num / den

    gate = []
    pos = [r for r in image_rows if r["fire"] or r["smoke"]]
    neg = [r for r in image_rows if not (r["fire"] or r["smoke"])]
    for t in thresholds:
        tp = sum(1 for r in pos if r["max_any"] >= t)
        fp = sum(1 for r in neg if r["max_any"] >= t)
        gate.append({
            "threshold": t,
            "recall_fire_or_smoke_images": rate(tp, len(pos)),
            "recall_images_with_fire": rate(sum(1 for r in pos if r["fire"] and r["max_any"] >= t), sum(1 for r in pos if r["fire"])),
            "recall_smoke_only_images": rate(sum(1 for r in pos if r["smoke"] and not r["fire"] and r["max_any"] >= t), sum(1 for r in pos if r["smoke"] and not r["fire"])),
            "false_alarm_rate_none_images": rate(fp, len(neg)),
            "image_precision": rate(tp, tp + fp),
            "false_alarm_rate_none_images_excluding_public": rate(sum(1 for r in neg if not r["public"] and r["max_any"] >= t), sum(1 for r in neg if not r["public"])),
        })
    report = {
        "model": os.path.basename(args.model),
        "input": size,
        "test_images": len(image_rows),
        "positives": len(pos),
        "none_images": len(neg),
        "coco": coco,
        "gate": gate,
        "cpu_ms_per_image": round(1000 * elapsed / max(1, len(image_rows)), 1),
        "notes": "COCO view: class-aware NMS 0.65, conf 0.001. Gate view: class-agnostic NMS 0.45 as in the extension; a frame fires when any fire/smoke box >= threshold. The extension also requires N-of-M hits, which this per-image number does not model.",
    }
    with open(args.out, "w") as fh:
        json.dump(report, fh, indent=1)
    print(json.dumps({k: report[k] for k in ("coco", "gate", "cpu_ms_per_image")}, indent=1))
    if not coco or math.isnan(coco["all"]["mAP50"]):
        raise SystemExit("evaluation produced no COCO result")


if __name__ == "__main__":
    main()

# Copyright (C) 2026 PacifAIst
# SPDX-License-Identifier: AGPL-3.0-only
"""
M2 Python reference for YOLOX decode + NMS.

A dependency-free port of Megvii's YOLOX demo postprocessing
(yolox/utils/demo_utils.py: demo_postprocess, nms, multiclass_nms_class_agnostic;
demo/ONNXRuntime/onnx_inference.py: xywh -> xyxy, divide by ratio, then NMS).

Input:  bench/fixtures/yolox_tiny_dog.raw.json (raw output anchors, written by
        apps/extension/scripts/gen-yolox-fixture.ts)
Output: bench/fixtures/yolox_tiny_dog.python.json

Usage:  python -I models/reference/yolox_reference.py
"""

import json
import math
import os
import sys

STRIDES = (8, 16, 32)
SCORE_THR = 0.1
NMS_THR = 0.45


def grids(input_h, input_w):
    """Anchor order: stride 8, 16, 32; each grid row-major (np.meshgrid default 'xy')."""
    out = []
    for s in STRIDES:
        hs, ws = input_h // s, input_w // s
        for y in range(hs):
            for x in range(ws):
                out.append((x, y, s))
    return out


def nms(boxes, scores, nms_thr):
    areas = [(b[2] - b[0] + 1) * (b[3] - b[1] + 1) for b in boxes]
    order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
    keep = []
    while order:
        i = order[0]
        keep.append(i)
        rest = []
        for j in order[1:]:
            xx1 = max(boxes[i][0], boxes[j][0])
            yy1 = max(boxes[i][1], boxes[j][1])
            xx2 = min(boxes[i][2], boxes[j][2])
            yy2 = min(boxes[i][3], boxes[j][3])
            w = max(0.0, xx2 - xx1 + 1)
            h = max(0.0, yy2 - yy1 + 1)
            inter = w * h
            ovr = inter / (areas[i] + areas[j] - inter)
            if ovr <= nms_thr:
                rest.append(j)
        order = rest
    return keep


def postprocess(fixture):
    g = grids(fixture["inputH"], fixture["inputW"])
    if len(g) != fixture["numAnchors"]:
        raise SystemExit("anchor count mismatch: %d vs %d" % (len(g), fixture["numAnchors"]))
    ratio = fixture["ratio"]
    boxes, scores, classes = [], [], []
    for a in fixture["anchors"]:
        gx, gy, s = g[a["index"]]
        v = a["values"]
        cx = (v[0] + gx) * s
        cy = (v[1] + gy) * s
        w = math.exp(v[2]) * s
        h = math.exp(v[3]) * s
        cls_scores = [v[4] * c for c in v[5:]]
        cls = max(range(len(cls_scores)), key=lambda k: cls_scores[k])
        score = cls_scores[cls]
        if score <= SCORE_THR:
            continue
        boxes.append([(cx - w / 2) / ratio, (cy - h / 2) / ratio, (cx + w / 2) / ratio, (cy + h / 2) / ratio])
        scores.append(score)
        classes.append(cls)
    keep = nms(boxes, scores, NMS_THR)
    return [
        {"x1": boxes[i][0], "y1": boxes[i][1], "x2": boxes[i][2], "y2": boxes[i][3], "score": scores[i], "classId": classes[i]}
        for i in keep
    ]


def main():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    src = os.path.join(root, "bench", "fixtures", "yolox_tiny_dog.raw.json")
    dst = os.path.join(root, "bench", "fixtures", "yolox_tiny_dog.python.json")
    with open(src, encoding="utf-8") as f:
        fixture = json.load(f)
    dets = postprocess(fixture)
    with open(dst, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"scoreThr": SCORE_THR, "nmsThr": NMS_THR, "detections": dets}, f, indent=1)
        f.write("\n")
    print("python reference: %d detections -> %s" % (len(dets), dst), file=sys.stderr)


if __name__ == "__main__":
    main()

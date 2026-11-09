# Copyright (C) 2026 PacifAIst
# SPDX-License-Identifier: AGPL-3.0-only
"""
Writes the fire/smoke fixture the extension's Vitest suite runs the shipped ONNX against
(apps/extension/test/fire-smoke-model.test.ts). Three CC0 D-Fire test images (not PublicDataset*):
one with fire, one with smoke only, one with neither. They are clear cases, chosen so the test checks
the JavaScript inference path (JPEG decode, letterbox, decode, NMS) against this Python path, not accuracy;
accuracy is the full test-split evaluation in evaluate_onnx.py.

Run inside the training container after train.sh:
  python /work/gen_fixture.py --out /data/out/fixture
then copy the folder's files to bench/fixtures/dfire/.
"""

import argparse
import json
import os
import shutil

import cv2
import numpy as np
import onnxruntime as ort

from evaluate_onnx import grids, letterbox, nms

IMAGES = {"fire": "AoF07798.jpg", "smoke": "WEB11359.jpg", "none": "WEB09870.jpg"}
CLASSES = ("fire", "smoke")
SCORE_THR = 0.25


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="/data/out/fire_smoke_yolox_tiny.onnx")
    ap.add_argument("--data", default="/data/dfire")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    test = json.load(open(os.path.join(args.data, "annotations", "test.json")))
    by_name = {i["file_name"]: i for i in test["images"]}
    cats = {c["id"]: c["name"] for c in test["categories"]}
    sess = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    grid, stride = grids(416, 416)

    rows = []
    for kind, name in IMAGES.items():
        info = by_name[name]
        src = os.path.join(args.data, "test2017", name)
        shutil.copyfile(src, os.path.join(args.out, name))
        img = cv2.imread(src)
        x, r = letterbox(img, 416)
        out = sess.run(None, {"images": x})[0][0]
        out[:, :2] = (out[:, :2] + grid) * stride
        out[:, 2:4] = np.exp(out[:, 2:4]) * stride
        boxes = np.stack([out[:, 0] - out[:, 2] / 2, out[:, 1] - out[:, 3] / 2, out[:, 0] + out[:, 2] / 2, out[:, 1] + out[:, 3] / 2], 1) / r
        scores = out[:, 4:5] * out[:, 5:]
        cls, best = scores.argmax(1), scores.max(1)
        m = best > SCORE_THR
        kept = nms(boxes[m], best[m], 0.45) if m.any() else []
        dets = [
            {"label": CLASSES[int(cls[m][k])], "score": round(float(best[m][k]), 5), "box": [round(float(v), 2) for v in boxes[m][k]]}
            for k in kept
        ]
        gt = [
            {"label": cats[a["category_id"]], "box": [a["bbox"][0], a["bbox"][1], a["bbox"][0] + a["bbox"][2], a["bbox"][1] + a["bbox"][3]]}
            for a in test["annotations"]
            if a["image_id"] == info["id"]
        ]
        rows.append({"kind": kind, "file": name, "width": info["width"], "height": info["height"], "groundTruth": gt, "pythonDetections": dets})

    fixture = {
        "source": "D-Fire test split (CC0 1.0; not PublicDataset*), https://github.com/gaiasd/DFireDataset",
        "scoreThr": SCORE_THR,
        "nmsThr": 0.45,
        "images": rows,
    }
    with open(os.path.join(args.out, "fire_smoke_dfire.python.json"), "w") as fh:
        json.dump(fixture, fh, indent=1)
    print(json.dumps(fixture, indent=1))


if __name__ == "__main__":
    main()

# Copyright (C) 2026 PacifAIst
# SPDX-License-Identifier: AGPL-3.0-only
"""
Collects the fire/smoke pipeline outputs into one evidence file (bench/reports/m2-fire-smoke.json), the input
of `pnpm bench`. Run inside the training container after train.sh:
  python /work/collect_report.py --out /data/out/m2-fire-smoke.json
"""

import argparse
import datetime
import hashlib
import json
import os
import re

AP_RE = re.compile(r"Average Precision\s+\(AP\) @\[ IoU=(0\.50:0\.95|0\.50)\s+\| area=\s*all \| maxDets=100 \] = (-?\d+\.\d+)")
TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")


def ap_blocks(text: str) -> list[dict[str, float]]:
    blocks, cur = [], {}
    for key, val in AP_RE.findall(text):
        cur["AP50_95" if key == "0.50:0.95" else "AP50"] = float(val)
        if len(cur) == 2:
            blocks.append(cur)
            cur = {}
    return blocks


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="/data")
    ap.add_argument("--out", required=True)
    ap.add_argument("--gpu", default="NVIDIA GeForce RTX 3060 Laptop GPU (6 GB)")
    args = ap.parse_args()
    out_dir = os.path.join(args.data, "out")
    onnx = os.path.join(out_dir, "fire_smoke_yolox_tiny.onnx")
    data = open(onnx, "rb").read()
    train_log = open(os.path.join(out_dir, "train.log"), encoding="utf8", errors="replace").read()
    torch_log = open(os.path.join(out_dir, "eval_torch_test.log"), encoding="utf8", errors="replace").read()
    manifest = json.load(open(os.path.join(args.data, "dfire", "manifest.json")))
    evaluation = json.load(open(os.path.join(out_dir, "eval.json")))

    val = ap_blocks(train_log)
    best = max(val, key=lambda b: b["AP50_95"]) if val else None
    stamps = [m.group(1) for line in train_log.splitlines() if (m := TS_RE.match(line))]
    minutes = None
    if len(stamps) >= 2:
        fmt = "%Y-%m-%d %H:%M:%S"
        minutes = (datetime.datetime.strptime(stamps[-1], fmt) - datetime.datetime.strptime(stamps[0], fmt)).total_seconds() / 60
    epochs = max((int(m) for m in re.findall(r"epoch: (\d+)/\d+", train_log)), default=0)
    batch = int(os.environ.get("BATCH", "16"))
    torch_test = ap_blocks(torch_log)

    report = {
        "model": "fire_smoke_yolox_tiny.onnx",
        "onnxSha256": hashlib.sha256(data).hexdigest(),
        "onnxBytes": len(data),
        "training": {
            "epochs": epochs,
            "batch": batch,
            "input": evaluation["input"],
            "trainImages": manifest["splits"]["train"]["images"],
            "valImages": manifest["splits"]["val"]["images"],
            "excludedPublicImages": sum(manifest["excluded_public_images"].values()),
            "bestValAP50_95": best["AP50_95"] if best else None,
            "bestValAP50": best["AP50"] if best else None,
            "valCurve": val,
            "gpu": args.gpu,
            "minutes": minutes,
            "pretrained": "Megvii YOLOX 0.1.1rc0 yolox_tiny.pth (COCO), sha256 9de513de...",
            "yoloxCommit": "6ddff4824372906469a7fae2dc3206c7aa4bbaee",
        },
        "dataset": {"source": manifest["source"], "verified": manifest["verified"], "official": manifest["official"], "splits": manifest["splits"]},
        "torchTest": torch_test[-1] if torch_test else None,
        "eval": evaluation,
    }
    with open(args.out, "w") as fh:
        json.dump(report, fh, indent=1)
    print(json.dumps({k: report[k] for k in ("onnxSha256", "onnxBytes", "torchTest")}, indent=1))
    print(json.dumps(report["training"] | {"valCurve": len(val)}, indent=1))


if __name__ == "__main__":
    main()

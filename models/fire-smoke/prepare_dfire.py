"""
Prepare D-Fire for YOLOX training (PLAN M2).

Source: the Hugging Face mirror `badsaarow/d-fire` at a pinned revision, because the official
OneDrive links (github.com/gaiasd/DFireDataset) need an interactive browser session. The mirror has no
license or provenance statement of its own, so this script refuses to continue unless the data matches
every number published in the official README: 21,527 images (1,164 fire only, 5,867 smoke only, 4,658
fire and smoke, 9,838 none), 14,692 fire boxes and 11,865 smoke boxes, plus the paper's 17,221 / 4,306
train/test split.

Licensing: the D-Fire LICENSE file dedicates the collection to CC0, but its README says images whose
filename starts with `PublicDataset` "remain subject to the terms of their original providers". With
--exclude-public (the default) those images are left out of training and validation, so the weights
are trained only on CC0 images. The official test split is evaluated in full.

Output (YOLOX COCO layout):
  <out>/train2017, val2017, test2017/*.jpg
  <out>/annotations/train.json, val.json, test.json   (category 1 = fire, 2 = smoke)
  <out>/manifest.json                                  (verification results and split counts)
"""

import argparse
import hashlib
import io
import json
import os
import sys
import urllib.request

import pyarrow.parquet as pq
from PIL import Image

REPO = "badsaarow/d-fire"
REVISION = "27f81e6f7d32fe3b29d366da9573b6150a3d148f"
FILES = [f"data/train-{i:05d}-of-00009.parquet" for i in range(9)] + [f"data/test-{i:05d}-of-00003.parquet" for i in range(3)]
OFFICIAL = {
    "images": 21527,
    "train": 17221,
    "test": 4306,
    "fire_only": 1164,
    "smoke_only": 5867,
    "fire_and_smoke": 4658,
    "none": 9838,
    "fire_boxes": 14692,
    "smoke_boxes": 11865,
}
# Our detector's class order (packages/recipes/src/models.ts): index 0 = fire, 1 = smoke.
CATEGORIES = [{"id": 1, "name": "fire"}, {"id": 2, "name": "smoke"}]


def download(out_dir: str) -> list[str]:
    paths = []
    for f in FILES:
        dst = os.path.join(out_dir, "parquet", f.replace("/", "_"))
        paths.append(dst)
        if os.path.exists(dst) and os.path.getsize(dst) > 0:
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        url = f"https://huggingface.co/datasets/{REPO}/resolve/{REVISION}/{f}"
        print(f"downloading {f}", file=sys.stderr, flush=True)
        tmp = dst + ".part"
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "survey-anything-prepare"}), timeout=120) as r, open(tmp, "wb") as fh:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                fh.write(chunk)
        os.replace(tmp, dst)
    return paths


def parse_label(text: str) -> list[tuple[int, float, float, float, float]]:
    boxes = []
    for line in (text or "").splitlines():
        parts = line.split()
        if len(parts) != 5:
            continue
        c, cx, cy, w, h = int(parts[0]), *map(float, parts[1:])
        boxes.append((c, cx, cy, w, h))
    return boxes


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/data/dfire")
    ap.add_argument("--val-fraction-mod", type=int, default=10, help="1 in N training images (by filename hash) go to validation")
    ap.add_argument("--include-public", action="store_true", help="also train on PublicDataset* images (not CC0)")
    args = ap.parse_args()
    out = args.out
    manifest_path = os.path.join(out, "manifest.json")
    if os.path.exists(manifest_path):
        print("already prepared:", manifest_path, file=sys.stderr)
        return

    rows = []  # (split, filename, jpeg bytes, boxes)
    for path in download(out):
        split = "train" if "_train-" in path else "test"
        table = pq.read_table(path, columns=["image", "label", "filename"])
        for img, label, fname in zip(table.column("image").to_pylist(), table.column("label").to_pylist(), table.column("filename").to_pylist()):
            rows.append((split, os.path.basename(fname), img["bytes"], parse_label(label)))

    # ---- verify against the official numbers before anything is trained -------------------------
    box_counts: dict[int, int] = {}
    cats = {"fire_only": 0, "smoke_only": 0, "fire_and_smoke": 0, "none": 0}
    for _, _, _, boxes in rows:
        for b in boxes:
            box_counts[b[0]] = box_counts.get(b[0], 0) + 1
    ids = sorted(box_counts)
    if len(ids) != 2:
        sys.exit(f"expected exactly 2 class ids, got {box_counts}")
    fire_id = next((i for i in ids if box_counts[i] == OFFICIAL["fire_boxes"]), None)
    smoke_id = next((i for i in ids if box_counts[i] == OFFICIAL["smoke_boxes"]), None)
    for _, _, _, boxes in rows:
        has_f = any(b[0] == fire_id for b in boxes)
        has_s = any(b[0] == smoke_id for b in boxes)
        cats["fire_and_smoke" if has_f and has_s else "fire_only" if has_f else "smoke_only" if has_s else "none"] += 1
    got = {
        "images": len(rows),
        "train": sum(1 for r in rows if r[0] == "train"),
        "test": sum(1 for r in rows if r[0] == "test"),
        **cats,
        "fire_boxes": box_counts.get(fire_id, -1) if fire_id is not None else -1,
        "smoke_boxes": box_counts.get(smoke_id, -1) if smoke_id is not None else -1,
    }
    mismatches = {k: (got[k], v) for k, v in OFFICIAL.items() if got[k] != v}
    if mismatches or fire_id is None or smoke_id is None:
        sys.exit(f"mirror does not match the official D-Fire numbers: {mismatches} (class box counts {box_counts})")
    names = [r[1] for r in rows]
    if len(set(names)) != len(names):
        sys.exit("duplicate filenames in mirror")
    print(f"verified: {got}; D-Fire class id {fire_id} = fire, {smoke_id} = smoke", file=sys.stderr)

    # ---- split and write ------------------------------------------------------------------------
    coco = {s: {"images": [], "annotations": [], "categories": CATEGORIES} for s in ("train", "val", "test")}
    excluded_public = {"train": 0, "val": 0}
    ann_id = 1
    for i, (split, fname, data, boxes) in enumerate(rows):
        target = split
        if split == "train" and int(hashlib.sha1(fname.encode()).hexdigest(), 16) % args.val_fraction_mod == 0:
            target = "val"
        if target in ("train", "val") and fname.startswith("PublicDataset") and not args.include_public:
            excluded_public[target] += 1
            continue
        d = os.path.join(out, f"{target}2017")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, fname), "wb") as fh:
            fh.write(data)
        w, h = Image.open(io.BytesIO(data)).size
        coco[target]["images"].append({"id": i + 1, "file_name": fname, "width": w, "height": h})
        for c, cx, cy, bw, bh in boxes:
            x = max(0.0, (cx - bw / 2) * w)
            y = max(0.0, (cy - bh / 2) * h)
            ww = min(w - x, bw * w)
            hh = min(h - y, bh * h)
            if ww <= 1 or hh <= 1:
                continue
            coco[target]["annotations"].append(
                {"id": ann_id, "image_id": i + 1, "category_id": 1 if c == fire_id else 2, "bbox": [x, y, ww, hh], "area": ww * hh, "iscrowd": 0}
            )
            ann_id += 1
    os.makedirs(os.path.join(out, "annotations"), exist_ok=True)
    for s, doc in coco.items():
        with open(os.path.join(out, "annotations", f"{s}.json"), "w") as fh:
            json.dump(doc, fh)
    manifest = {
        "source": f"https://huggingface.co/datasets/{REPO}/tree/{REVISION}",
        "official": OFFICIAL,
        "verified": got,
        "dfire_class_ids": {"fire": fire_id, "smoke": smoke_id},
        "exclude_public": not args.include_public,
        "excluded_public_images": excluded_public,
        "splits": {s: {"images": len(d["images"]), "boxes": len(d["annotations"])} for s, d in coco.items()},
    }
    with open(manifest_path, "w") as fh:
        json.dump(manifest, fh, indent=1)
    print(json.dumps(manifest["splits"]), file=sys.stderr)


if __name__ == "__main__":
    main()

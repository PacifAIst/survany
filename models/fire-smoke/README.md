# Fire and smoke detector (PLAN M2)

YOLOX-tiny fine-tuned on D-Fire. The extension's `fire` recipe uses it through the `fire-smoke-yolox-tiny`
detector (class 0 = fire, 1 = smoke). Results: `docs/BENCHMARKS.md`. Model card: `MODEL_CARD.md`.

## Where the weights live

The ONNX file is not in git. It is a GitHub release asset
([`fire-smoke-yolox-tiny-v1`](https://github.com/PacifAIst/survany/releases/tag/fire-smoke-yolox-tiny-v1)),
pinned by SHA-256 in `CHECKSUMS.txt` (and again in `models/checksums.json` for the extension bundle).
`scripts/fetch-model.ts` downloads it on `pnpm install` and before `fetch-assets`, hashes it in memory and
writes it here only if it matches; a file that does not match is never written. Offline:
`SA_SKIP_MODEL_FETCH=1 pnpm install`, then `node scripts/fetch-model.ts` later.

## Reproduce

Needs Docker with an NVIDIA GPU (tested: RTX 3060 Laptop, 6 GB, driver 556, CUDA 12.4 image). From the
repository root:

```bash
docker build -t sa-fire-train models/fire-smoke
docker run --rm --gpus all --shm-size 8g \
  -v sa-dfire:/data -v "$PWD/models/fire-smoke:/work:ro" \
  -e EPOCHS=40 -e BATCH=16 \
  sa-fire-train bash /work/train.sh
docker run --rm -v sa-dfire:/data -v "$PWD/models/fire-smoke:/work:ro" sa-fire-train \
  python /work/collect_report.py --out /data/out/m2-fire-smoke.json
```

Then, for a new model:

1. Publish `/data/out/fire_smoke_yolox_tiny.onnx` as a new release asset with a new tag, e.g.
   `gh release create fire-smoke-yolox-tiny-v2 fire_smoke_yolox_tiny.onnx --latest=false --notes-file notes.md`.
2. Put its SHA-256 in `CHECKSUMS.txt` and `models/checksums.json`, and the new tag in `MODEL_RELEASES`
   in `scripts/fetch-model.ts` (`scripts/fetch-model.test.ts` checks that the three agree).
3. Copy `m2-fire-smoke.json` to `bench/reports/` and run `pnpm bench`. If fire mAP@0.5 is below 0.70,
   do not ship it (`pnpm bench` fails; see the retrain rule in `docs/BENCHMARKS.md`).
4. Regenerate the JavaScript-path fixture (`python /work/gen_fixture.py --out /data/out/fixture`, run with
   `-w /work`, then copy the folder's files to `bench/fixtures/dfire/`) and update `MODEL_CARD.md`.

## Pipeline

| Step | File | What it does |
|---|---|---|
| Data | `prepare_dfire.py` | Downloads the D-Fire mirror at a pinned revision, **refuses to continue unless every count in the official README matches**, maps D-Fire's class ids (smoke 0, fire 1) to ours (fire 0, smoke 1), holds out 1 in 10 training images for validation, leaves out `PublicDataset*` images from training (not CC0), and writes COCO annotations. |
| Train | `exp_fire_smoke_tiny.py`, `train.sh` | YOLOX at commit `6ddff48`, YOLOX-tiny settings, 416 input, from Megvii's COCO `yolox_tiny.pth` (sha256 pinned), fp16. |
| Export | `train.sh` | `tools/export_onnx.py` with `decode_in_inference` off: raw grids, which `apps/extension/src/worker/yolox-decode.ts` decodes. The Dockerfile renames that script's `torch.onnx._export` call to `torch.onnx.export` (the private name is gone in torch 2.5), and `train.sh` stops if no ONNX was written, because YOLOX's tools exit 0 after logging an exception. |
| Evaluate | `evaluate_onnx.py` | On the official test split, with the extension's preprocessing: COCO mAP, plus the per-frame gate view (recall on fire/smoke images, false alarms on "none" images per threshold). |
| Report | `collect_report.py` | Writes the evidence file that `pnpm bench` renders. |
| JS fixture | `gen_fixture.py` | Three CC0 test images and the Python path's detections on them; `apps/extension/test/fire-smoke-model.test.ts` checks the extension's JavaScript path gives the same result. |

## Data source and licensing

The official download links are OneDrive shares that need an interactive browser session, so the
pipeline uses the Hugging Face mirror `badsaarow/d-fire` (revision `27f81e6f`). The mirror states no
license or provenance, which is why `prepare_dfire.py` verifies it against the official numbers:
21,527 images (1,164 fire only, 5,867 smoke only, 4,658 both, 9,838 none), 14,692 fire boxes,
11,865 smoke boxes, and the 17,221 / 4,306 train/test split. All matched on 2026-11-09.

D-Fire's LICENSE file is CC0 1.0. Its README adds that images whose names start with `PublicDataset`
remain under the terms of their original providers (HPWREN, FESB Wildfire Observers, FireNet), and FESB
asks for credit. Those images are excluded from training by default (`--include-public` brings them back).

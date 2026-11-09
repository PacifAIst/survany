# Model card: fire_smoke_yolox_tiny.onnx

| | |
|---|---|
| File | `models/fire-smoke/fire_smoke_yolox_tiny.onnx`, bundled as `models/fire_smoke_yolox_tiny.onnx` |
| SHA-256 | `808ce9b61dcc389758893cefd178d12ca60c9dfc0367695a0e1781c260757912` (20,168,323 bytes), pinned in `models/checksums.json` |
| Architecture | YOLOX-tiny (depth 0.33, width 0.375), 416×416 input, 2 classes |
| Used by | the `fire` recipe through the `fire-smoke-yolox-tiny` detector gate |
| License | Apache-2.0 (see "License and attribution") |
| Trained | 2026-11-09, 40 epochs, 152 minutes on one RTX 3060 Laptop GPU (6 GB) |

## What it does

It finds fire and smoke in a single frame and returns boxes. It is the **first stage** of the `fire`
recipe: when a fire or smoke box reaches the gate threshold in 2 of the last 3 frames (defaults), the
extension asks the configured vision model to confirm before anyone is alerted. It does not decide on its
own that there is a hazard.

## Input and output

- Input `images`, float32 `[1, 3, 416, 416]`: BGR, values 0–255, no normalization, letterboxed (top-left,
  pad value 114). This is the same preprocessing as Megvii's COCO `yolox_tiny.onnx`, so both models share one
  code path in the extension.
- Output `output`, float32 `[1, 3549, 7]`: raw grid predictions for strides 8, 16 and 32 (`cx, cy, w, h` as
  grid offsets and log sizes, then objectness, then class scores for `fire` and `smoke`, all three already
  passed through a sigmoid). `apps/extension/src/worker/yolox-decode.ts` decodes them. Exported with
  `decode_in_inference` off, opset 11, no onnx-simplifier.

## Training data

[D-Fire](https://github.com/gaiasd/DFireDataset) (S24), 21,527 images of outdoor and wildland scenes, many
from surveillance-style viewpoints, labelled with fire and smoke boxes. D-Fire's LICENSE file is CC0 1.0.

- Obtained from the Hugging Face mirror `badsaarow/d-fire` at revision `27f81e6f`, because the official
  links are OneDrive shares that need an interactive browser. The mirror states no provenance, so
  `prepare_dfire.py` refuses to continue unless every count in the official README matches (image totals per
  category, box totals per class, and the train/test split). All matched.
- **Images whose names start with `PublicDataset` were left out** of training and validation (956 + 99 =
  1,055). D-Fire's README says they remain under the terms of their original providers (HPWREN, FESB Wildfire
  Observers, FireNet). The weights are therefore trained on CC0 images only.
- Training: 14,572 images. Validation (checkpoint selection): 1,594 images, 1 in 10 training images chosen
  by a hash of the file name. Test: the official 4,306-image test split, in full, never used for training or
  for choosing the checkpoint.

## Training procedure

YOLOX at commit `6ddff48` (Apache-2.0), starting from Megvii's COCO `yolox_tiny.pth` (release 0.1.1rc0,
sha256 `9de513de…`). YOLOX-tiny settings: mosaic augmentation (mixup off), the last 5 epochs without augmentation,
2 warm-up epochs, batch 16, fp16. The checkpoint with the best validation mAP@0.5:0.95 (0.419,
epoch 40) was exported. The whole pipeline is `models/fire-smoke/train.sh` in a pinned Docker image.

## Evaluation (official D-Fire test split)

Measured on the exported ONNX with the extension's preprocessing (`evaluate_onnx.py`).

| Class | mAP@0.5 | mAP@0.5:0.95 |
|---|---|---|
| all | 0.753 | 0.415 |
| fire | 0.703 | 0.356 |
| smoke | 0.803 | 0.474 |

YOLOX's own evaluator on the PyTorch checkpoint agrees (0.752 / 0.415), so the export and the
preprocessing are consistent.

Per frame, as the gate sees it (class-agnostic NMS, any fire or smoke box at or above the threshold):

| Threshold | Recall: images with fire | Recall: smoke-only images | False alarms on "none" images |
|---|---|---|---|
| 0.25 | 98.7% | 89.6% | 2.2% |
| 0.5 | 96.5% | 78.2% | 0.9% |
| **0.6 (default)** | **93.8%** | **69.8%** | **0.5%** |

Full table and all numbers: `docs/BENCHMARKS.md` (generated from `bench/reports/m2-fire-smoke.json`).

The extension runs the same file through its own JavaScript path in
`apps/extension/test/fire-smoke-model.test.ts`: on three D-Fire test images, scores match the Python path
within 0.001 and boxes overlap at IoU ≥ 0.97.

## Limitations

- **Smoke without visible flame is missed often at the default threshold** (69.8% recall per frame). Lowering
  the recipe's `minConfidence` to 0.5 or 0.4 raises it to 78% or 84% at about 2× or 3× the per-frame false
  alarms. The vision-model confirmation step absorbs some of that.
- **Small or distant fire is weak** (COCO AP for small objects 0.152 vs 0.508 for large).
- **Domain.** D-Fire is mostly outdoor scenery, buildings, vehicles and wildland. Indoor home cameras,
  night infrared, fisheye lenses and screens showing fire are under-represented or absent. The false-alarm
  rate on D-Fire's "none" images is not a prediction for those settings. Sunset, orange-clothing and
  on-screen-fire clips are listed as not measured yet in `docs/BENCHMARKS.md`.
- Per-frame numbers ignore the 2-of-3 frame rule and the vision-model confirmation, which both lower false
  alarms. They also ignore that consecutive frames are correlated, which limits how much the frame rule helps.
- Not a certified fire detector. It does not replace smoke alarms.

## License and attribution

- The weights are a derivative of Megvii's YOLOX-tiny COCO weights (Apache-2.0, © Megvii Inc.), fine-tuned
  with YOLOX code (Apache-2.0) on CC0 data. They are distributed under Apache-2.0.
- D-Fire: https://github.com/gaiasd/DFireDataset (CC0 1.0). Its README gives the paper to cite; credit is
  given here as a courtesy.
- The three test images in `bench/fixtures/dfire/` (AoF07798.jpg, WEB11359.jpg, WEB09870.jpg) are from the
  CC0 part of the D-Fire test split.

## Reproduce

See `README.md` in this folder. Training is not bit-for-bit reproducible (cuDNN non-determinism and data
loader ordering), so a re-run gives close but not identical numbers; the shipped file is pinned by SHA-256.

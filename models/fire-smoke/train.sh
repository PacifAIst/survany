#!/usr/bin/env bash
# Fire/smoke detector pipeline (PLAN M2): prepare D-Fire -> fine-tune YOLOX-tiny -> evaluate -> export ONNX.
# Run from the repository root (see models/fire-smoke/README.md):
#   docker build -t sa-fire-train models/fire-smoke
#   docker run --rm --gpus all --shm-size 8g -v sa-dfire:/data -v "$PWD/models/fire-smoke:/work:ro" sa-fire-train bash /work/train.sh
set -euo pipefail
WORK=/work
OUT=/data/out
RUN=/data/runs/fire_smoke_yolox_tiny
mkdir -p "$OUT"

python "$WORK/prepare_dfire.py" --out /data/dfire

# Megvii's COCO-pretrained YOLOX-tiny (Apache-2.0), pinned by SHA-256.
WEIGHTS=/data/yolox_tiny.pth
if [ ! -f "$WEIGHTS" ]; then
  curl -sSL -o "$WEIGHTS" https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.pth
fi
echo "9de513de589ac98bb92d3bca53b5af7b9acfa9b0bacb831f7999d0f7afaee8f0  $WEIGHTS" | sha256sum -c -

cd /opt/YOLOX
if [ ! -f "$RUN/best_ckpt.pth" ] || [ "${RETRAIN:-0}" = "1" ]; then
  python tools/train.py -f "$WORK/exp_fire_smoke_tiny.py" -d 1 -b "${BATCH:-16}" --fp16 -c "$WEIGHTS" 2>&1 | tee "$OUT/train.log"
fi

# Cross-check with YOLOX's own evaluator on the official test split.
python tools/eval.py -f "$WORK/exp_fire_smoke_tiny.py" -c "$RUN/best_ckpt.pth" -b 16 -d 1 --conf 0.001 --test --fp16 2>&1 | tee "$OUT/eval_torch_test.log"

# Export with decode_in_inference off: the extension decodes grids itself (apps/extension/src/worker/yolox-decode.ts).
python tools/export_onnx.py -f "$WORK/exp_fire_smoke_tiny.py" -c "$RUN/best_ckpt.pth" --output-name "$OUT/fire_smoke_yolox_tiny.onnx" --no-onnxsim 2>&1 | tee "$OUT/export.log"
# YOLOX's tools wrap main() in @logger.catch, which logs an exception and still exits 0.
test -s "$OUT/fire_smoke_yolox_tiny.onnx" || { echo "export failed: no ONNX written" >&2; exit 1; }

python "$WORK/evaluate_onnx.py" --model "$OUT/fire_smoke_yolox_tiny.onnx" --data /data/dfire --out "$OUT/eval.json" 2>&1 | tee "$OUT/eval_onnx.log"
cp /data/dfire/manifest.json "$OUT/dataset_manifest.json"
sha256sum "$OUT/fire_smoke_yolox_tiny.onnx" | tee "$OUT/fire_smoke_yolox_tiny.onnx.sha256"
echo "PIPELINE DONE"

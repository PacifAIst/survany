// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/** Bundled detector models and their class labels (§6.3 `detector` gate, §11 licensing). */

export const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard',
  'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
  'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard',
  'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase',
  'scissors', 'teddy bear', 'hair drier', 'toothbrush',
] as const;

export const FIRE_SMOKE_CLASSES = ['fire', 'smoke'] as const;

export interface DetectorModelInfo {
  id: string;
  file: string;
  classes: readonly string[];
  license: string;
  /** When the weights are absent the runtime uses this documented fallback (§6.3 interim gate). */
  fallback: 'none' | 'flame-heuristic';
}

export const DETECTOR_MODELS: Record<string, DetectorModelInfo> = {
  'yolox-tiny-coco': {
    id: 'yolox-tiny-coco',
    file: 'models/yolox_tiny.onnx',
    classes: COCO_CLASSES,
    license: 'Apache-2.0',
    fallback: 'none',
  },
  'fire-smoke-yolox-tiny': {
    id: 'fire-smoke-yolox-tiny',
    file: 'models/fire_smoke_yolox_tiny.onnx',
    classes: FIRE_SMOKE_CLASSES,
    license: 'Apache-2.0',
    fallback: 'flame-heuristic',
  },
};

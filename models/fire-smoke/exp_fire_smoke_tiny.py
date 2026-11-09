"""YOLOX-tiny experiment for D-Fire fire/smoke (PLAN M2). Fine-tuned from Megvii's COCO yolox_tiny.pth."""

import os

from yolox.exp import Exp as BaseExp


class Exp(BaseExp):
    def __init__(self) -> None:
        super().__init__()
        # YOLOX-tiny (same as exps/default/yolox_tiny.py)
        self.depth = 0.33
        self.width = 0.375
        self.input_size = (416, 416)
        self.test_size = (416, 416)
        self.mosaic_scale = (0.5, 1.5)
        self.random_size = (10, 20)
        self.enable_mixup = False

        # D-Fire: category 1 = fire, 2 = smoke -> class index 0 = fire, 1 = smoke (matches the extension).
        self.num_classes = 2
        self.data_dir = os.environ.get("DFIRE_DIR", "/data/dfire")
        self.train_ann = "train.json"
        self.val_ann = "val.json"
        self.test_ann = "test.json"

        self.max_epoch = int(os.environ.get("EPOCHS", "40"))
        self.no_aug_epochs = int(os.environ.get("NO_AUG_EPOCHS", "5"))
        self.warmup_epochs = 2
        self.eval_interval = int(os.environ.get("EVAL_INTERVAL", "5"))
        self.print_interval = 50
        self.save_history_ckpt = False
        self.data_num_workers = int(os.environ.get("WORKERS", "6"))
        self.output_dir = os.environ.get("RUNS_DIR", "/data/runs")
        self.exp_name = "fire_smoke_yolox_tiny"

# Training image for the fire/smoke detector (PLAN M2). GPU: docker run --gpus all ...
FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime@sha256:c8268a92a69bd500f8be0e665b2630ee006dadaf7bfbc24249141b15ff622755
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends git build-essential curl && rm -rf /var/lib/apt/lists/*
# YOLOX (Apache-2.0), pinned commit.
RUN git clone https://github.com/Megvii-BaseDetection/YOLOX.git /opt/YOLOX \
 && git -C /opt/YOLOX checkout 6ddff4824372906469a7fae2dc3206c7aa4bbaee
RUN pip install \
      "numpy<2" "opencv-python-headless==4.10.0.84" "loguru==0.7.2" "tqdm==4.67.1" "thop==0.1.1.post2209072238" \
      "ninja==1.11.1.3" "tabulate==0.9.0" "psutil==6.1.1" "tensorboard==2.18.0" "pycocotools==2.0.8" \
      "onnx==1.17.0" "onnxruntime==1.20.1" "pyarrow==18.1.0" "pillow==11.1.0"
ENV PYTHONPATH=/opt/YOLOX
WORKDIR /opt/YOLOX

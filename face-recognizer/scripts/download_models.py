#!/usr/bin/env python3
"""Download the OpenCV YuNet + SFace models into face-recognizer/models/ and
verify their SHA-256. Model weights are git-ignored; never commit them."""
from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
ZOO = "https://github.com/opencv/opencv_zoo/raw/main/models"
MODELS = {
    "face_detection_yunet_2023mar.onnx": (
        f"{ZOO}/face_detection_yunet/face_detection_yunet_2023mar.onnx",
        "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    ),
    "face_recognition_sface_2021dec.onnx": (
        f"{ZOO}/face_recognition_sface/face_recognition_sface_2021dec.onnx",
        "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    ),
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    for name, (url, expected) in MODELS.items():
        target = MODELS_DIR / name
        if target.exists() and sha256(target) == expected:
            print(f"ok       {name}")
            continue
        print(f"download {name}")
        try:
            urllib.request.urlretrieve(url, target)
        except OSError as err:
            print(f"ERROR: could not download {url}: {err}", file=sys.stderr)
            return 1
        actual = sha256(target)
        if actual != expected:
            target.unlink()
            print(f"ERROR: {name} checksum mismatch (got {actual}); file removed", file=sys.stderr)
            return 1
        print(f"ok       {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Face detection + embedding behind a small interface, so other models
(e.g. InsightFace) can be benchmarked later without touching the service."""
from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import cv2
import numpy as np

YUNET_FILE = "face_detection_yunet_2023mar.onnx"
SFACE_FILE = "face_recognition_sface_2021dec.onnx"


@dataclass(frozen=True)
class DetectedFace:
    x: int
    y: int
    width: int
    height: int
    score: float
    raw: np.ndarray  # detector output row; needed for alignment

    @property
    def area(self) -> int:
        return self.width * self.height


class Embedder(Protocol):
    name: str

    def detect(self, image_bgr: np.ndarray) -> list[DetectedFace]:
        """All faces in the image, largest first."""

    def embed(self, image_bgr: np.ndarray, face: DetectedFace) -> np.ndarray:
        """L2-normalized float32 embedding for one detected face."""


class OpenCVSFaceEmbedder:
    """OpenCV YuNet (detection, MIT) + SFace (128-d embedding, Apache-2.0)."""

    name = "opencv-yunet-2023mar+sface-2021dec"

    def __init__(self, models_dir: Path, detection_score: float = 0.9):
        detector_path = models_dir / YUNET_FILE
        recognizer_path = models_dir / SFACE_FILE
        for path in (detector_path, recognizer_path):
            if not path.exists():
                raise FileNotFoundError(f"{path} missing; run scripts/download_models.py")
        self._detector = cv2.FaceDetectorYN.create(str(detector_path), "", (320, 320), detection_score, 0.3, 5000)
        self._recognizer = cv2.FaceRecognizerSF.create(str(recognizer_path), "")
        # OpenCV DNN objects are not thread-safe; FastAPI runs sync handlers in a pool
        self._lock = threading.Lock()

    def detect(self, image_bgr: np.ndarray) -> list[DetectedFace]:
        height, width = image_bgr.shape[:2]
        with self._lock:
            self._detector.setInputSize((width, height))
            _, rows = self._detector.detect(image_bgr)
        if rows is None:
            return []
        faces = [
            DetectedFace(
                x=int(row[0]), y=int(row[1]), width=int(row[2]), height=int(row[3]),
                score=float(row[14]), raw=row.copy(),
            )
            for row in rows
        ]
        return sorted(faces, key=lambda f: f.area, reverse=True)

    def embed(self, image_bgr: np.ndarray, face: DetectedFace) -> np.ndarray:
        with self._lock:
            aligned = self._recognizer.alignCrop(image_bgr, face.raw)
            feature = self._recognizer.feature(aligned)
        vector = np.asarray(feature, dtype=np.float32).reshape(-1)
        return vector / np.linalg.norm(vector)

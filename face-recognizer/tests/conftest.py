"""Test helpers. No real faces are committed: service tests use a fake
embedder driven by synthetic images; real-model tests use local LFW data and
skip when it isn't present."""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.embedder import DetectedFace  # noqa: E402


def jpeg(image: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 95])
    assert ok
    return buf.tobytes()


def synthetic_face_image(identity: int, size: int = 200, blur: bool = False, faces: int = 1) -> np.ndarray:
    """A 'photo' the fake embedder understands: the red channel of the top-left
    pixel encodes the identity, the blue channel the number of faces, and a
    noise texture gives the face region real sharpness (or none when blurred)."""
    rng = np.random.default_rng(identity)
    image = rng.integers(0, 255, (400, 400, 3), dtype=np.uint8)
    if blur:
        image = cv2.GaussianBlur(image, (0, 0), 12)
    image[0, 0] = (faces, 0, identity)  # BGR
    image[0, 1] = (size % 256, size // 256, 0)
    return image


class FakeEmbedder:
    """Deterministic stand-in for the OpenCV models. Reads the markers written
    by synthetic_face_image; embeddings are near-identical per identity."""

    name = "fake-embedder"

    def detect(self, image_bgr: np.ndarray) -> list[DetectedFace]:
        faces = int(image_bgr[0, 0, 0])
        size = int(image_bgr[0, 1, 0]) + 256 * int(image_bgr[0, 1, 1])
        return [
            DetectedFace(x=50 + 10 * i, y=50, width=size - i, height=size - i, score=0.99, raw=np.zeros(15, np.float32))
            for i in range(faces)
        ]

    def embed(self, image_bgr: np.ndarray, face: DetectedFace) -> np.ndarray:
        identity = int(image_bgr[0, 0, 2])
        base = np.random.default_rng(1000 + identity).normal(size=128).astype(np.float32)
        jitter = np.random.default_rng(int(image_bgr[5, 5].sum())).normal(scale=0.05, size=128).astype(np.float32)
        vector = base + jitter
        return vector / np.linalg.norm(vector)


# JPEG re-encoding alters pixel values; tests send PNG so markers survive
def png(image: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", image)
    assert ok
    return buf.tobytes()


@pytest.fixture
def fake_embedder() -> FakeEmbedder:
    return FakeEmbedder()

"""Enrollment quality gates (spec §2.3)."""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .embedder import DetectedFace

MIN_FACE_PX = 112
SHARPNESS_CROP_PX = 112
# Measured on 150 LFW faces (see face-recognizer/README.md): sharp originals
# p5 = 48, Gaussian-blurred (sigma 1.5) p95 = 39. The spec's 100 would reject
# about half of sharp photos on this normalized scale.
MIN_SHARPNESS = 40.0


@dataclass(frozen=True)
class QualityResult:
    ok: bool
    reason: str | None = None
    face: DetectedFace | None = None
    sharpness: float | None = None


def face_sharpness(image_bgr: np.ndarray, face: DetectedFace) -> float:
    """Variance of the Laplacian over the face region resized to 112x112, so
    the score doesn't depend on photo resolution (higher = sharper)."""
    height, width = image_bgr.shape[:2]
    x0, y0 = max(face.x, 0), max(face.y, 0)
    x1, y1 = min(face.x + face.width, width), min(face.y + face.height, height)
    crop = image_bgr[y0:y1, x0:x1]
    if crop.size == 0:
        return 0.0
    crop = cv2.resize(crop, (SHARPNESS_CROP_PX, SHARPNESS_CROP_PX), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def check_enrollment_quality(
    image_bgr: np.ndarray,
    faces: list[DetectedFace],
    min_face_px: int = MIN_FACE_PX,
    min_sharpness: float = MIN_SHARPNESS,
) -> QualityResult:
    if not faces:
        return QualityResult(False, "no_face")
    if len(faces) > 1:
        return QualityResult(False, "multiple_faces")
    face = faces[0]
    if min(face.width, face.height) < min_face_px:
        return QualityResult(False, "face_too_small", face)
    sharpness = face_sharpness(image_bgr, face)
    if sharpness < min_sharpness:
        return QualityResult(False, "too_blurry", face, sharpness)
    return QualityResult(True, None, face, sharpness)

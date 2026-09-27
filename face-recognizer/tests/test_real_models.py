"""Integration tests with the real OpenCV models on local LFW photos (public
dataset, git-ignored). Skipped when models or LFW haven't been downloaded."""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest

from app.embedder import SFACE_FILE, YUNET_FILE, OpenCVSFaceEmbedder
from app.images import decode_image
from app.quality import check_enrollment_quality

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "models"
LFW = ROOT / "data" / "lfw" / "lfw_home" / "lfw"

pytestmark = pytest.mark.skipif(
    not ((MODELS / YUNET_FILE).exists() and (MODELS / SFACE_FILE).exists() and LFW.exists()),
    reason="models or LFW not downloaded (scripts/download_models.py; see README)",
)


@pytest.fixture(scope="module")
def embedder():
    return OpenCVSFaceEmbedder(MODELS)


def load(path: Path) -> np.ndarray:
    image = decode_image(path.read_bytes())
    return cv2.resize(image, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)


def embedding(embedder, path: Path) -> np.ndarray:
    image = load(path)
    faces = embedder.detect(image)
    assert faces, f"no face in {path.name}"
    return embedder.embed(image, faces[0])


def people_with_two_photos(n: int) -> list[list[Path]]:
    found = []
    for person in sorted(LFW.iterdir()):
        photos = sorted(person.glob("*.jpg"))
        if len(photos) >= 2:
            found.append(photos[:2])
        if len(found) == n:
            break
    return found


def test_embeddings_are_unit_length(embedder):
    [a, _] = people_with_two_photos(1)[0]
    assert np.isclose(np.linalg.norm(embedding(embedder, a)), 1.0, atol=1e-5)


def test_same_person_scores_higher_than_different_people(embedder):
    people = people_with_two_photos(6)
    vectors = [(embedding(embedder, a), embedding(embedder, b)) for a, b in people]
    same = [float(a @ b) for a, b in vectors]
    diff = [float(vectors[i][0] @ vectors[j][0]) for i in range(len(vectors)) for j in range(i + 1, len(vectors))]
    assert np.mean(same) > np.mean(diff) + 0.3
    assert min(same) > max(diff) - 0.1


def test_blank_image_has_no_face(embedder):
    blank = np.full((480, 640, 3), 128, np.uint8)
    assert embedder.detect(blank) == []
    assert check_enrollment_quality(blank, []).reason == "no_face"


def test_detection_coordinates_map_back_to_full_resolution(embedder):
    [a, _] = people_with_two_photos(1)[0]
    base = load(a)                                  # 500x500
    big = cv2.resize(base, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)  # 2000x2000, detected at 640
    f_base, f_big = embedder.detect(base)[0], embedder.detect(big)[0]
    assert f_big.width == pytest.approx(4 * f_base.width, rel=0.1)
    assert f_big.x == pytest.approx(4 * f_base.x, abs=4 * 8)
    # alignment on the big image uses mapped landmarks, so the identity is preserved
    assert float(embedder.embed(base, f_base) @ embedder.embed(big, f_big)) > 0.9

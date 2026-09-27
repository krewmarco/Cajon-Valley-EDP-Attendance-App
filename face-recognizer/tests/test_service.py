from __future__ import annotations

import builtins
import os
import tempfile
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.index import EmbeddingIndex, IndexModelMismatch
from app.main import Settings, confidence_level, create_app
from app.quality import check_enrollment_quality

from conftest import png, synthetic_face_image


def make_client(fake_embedder, index_dir: Path | None = None) -> TestClient:
    return TestClient(create_app(Settings(index_dir=index_dir, match_threshold=0.363, high_threshold=0.5), embedder=fake_embedder))


def enroll(client, label, images):
    files = [("photos", (f"p{i}.png", png(img), "image/png")) for i, img in enumerate(images)]
    return client.post("/api/v1/enroll", data={"label": label}, files=files)


def recognize(client, image):
    return client.post("/api/v1/recognize", files={"frame": ("frame.png", png(image), "image/png")})


# ── quality gates ─────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "image, reason",
    [
        (synthetic_face_image(1, faces=0), "no_face"),
        (synthetic_face_image(1, faces=2), "multiple_faces"),
        (synthetic_face_image(1, size=100), "face_too_small"),
        (synthetic_face_image(1, blur=True), "too_blurry"),
    ],
)
def test_quality_gate_rejections(fake_embedder, image, reason):
    result = check_enrollment_quality(image, fake_embedder.detect(image))
    assert not result.ok
    assert result.reason == reason


def test_sharpness_does_not_depend_on_resolution(fake_embedder):
    from app.quality import face_sharpness

    image = synthetic_face_image(1)
    face = fake_embedder.detect(image)[0]
    doubled = cv2.resize(image, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST)
    doubled_face = type(face)(face.x * 2, face.y * 2, face.width * 2, face.height * 2, face.score, face.raw)
    assert face_sharpness(doubled, doubled_face) == pytest.approx(face_sharpness(image, face), rel=0.05)


def test_quality_gate_accepts_a_good_photo(fake_embedder):
    image = synthetic_face_image(1)
    result = check_enrollment_quality(image, fake_embedder.detect(image))
    assert result.ok and result.sharpness > 100


# ── enroll / recognize / delete ───────────────────────────────────────────
def test_enroll_reports_accepted_and_rejected_with_reasons(fake_embedder):
    client = make_client(fake_embedder)
    res = enroll(client, "owner", [synthetic_face_image(7), synthetic_face_image(7, blur=True), synthetic_face_image(7, faces=0)])
    body = res.json()
    assert res.status_code == 200
    assert body["accepted"] == 1
    assert [r["reason"] for r in body["rejected"]] == ["too_blurry", "no_face"]


def test_enroll_rejects_unreadable_files(fake_embedder):
    client = make_client(fake_embedder)
    res = client.post("/api/v1/enroll", data={"label": "owner"}, files=[("photos", ("x.jpg", b"not an image", "image/jpeg"))])
    assert res.json()["rejected"] == [{"file": "x.jpg", "reason": "unreadable_image"}]


def test_enroll_validates_label(fake_embedder):
    client = make_client(fake_embedder)
    assert enroll(client, " ", [synthetic_face_image(1)]).status_code == 400


def test_recognize_ranks_the_enrolled_identity_first(fake_embedder):
    client = make_client(fake_embedder)
    enroll(client, "owner", [synthetic_face_image(7)])
    enroll(client, "someone-else", [synthetic_face_image(9)])

    body = recognize(client, synthetic_face_image(7)).json()

    assert body["face_detected"] is True
    assert body["bounding_box"]["width"] == 200
    assert [c["label"] for c in body["candidates"]] == ["owner", "someone-else"]
    assert body["candidates"][0]["score"] > 0.9
    assert body["candidates"][0]["confidence_level"] == "HIGH"
    assert body["inference_time_ms"] >= 0


def test_recognize_without_a_face(fake_embedder):
    client = make_client(fake_embedder)
    body = recognize(client, synthetic_face_image(1, faces=0)).json()
    assert body == {"face_detected": False, "bounding_box": None, "candidates": [], "inference_time_ms": body["inference_time_ms"]}


def test_recognize_rejects_unreadable_frames(fake_embedder):
    client = make_client(fake_embedder)
    res = client.post("/api/v1/recognize", files={"frame": ("f.jpg", b"garbage", "image/jpeg")})
    assert res.status_code == 400


def test_delete_removes_a_label(fake_embedder):
    client = make_client(fake_embedder)
    enroll(client, "owner", [synthetic_face_image(7), synthetic_face_image(7)])
    assert client.delete("/api/v1/enroll/owner").json() == {"label": "owner", "removed": 2}
    assert recognize(client, synthetic_face_image(7)).json()["candidates"] == []
    assert client.delete("/api/v1/enroll/owner").status_code == 404


def test_health_reports_counts_but_no_biometric_data(fake_embedder):
    client = make_client(fake_embedder)
    enroll(client, "owner", [synthetic_face_image(7)])
    body = client.get("/api/v1/health").json()
    assert body["enrolled_labels"] == 1 and body["enrolled_embeddings"] == 1
    assert "owner" not in str(body)


def test_confidence_levels():
    settings = Settings(index_dir=None, match_threshold=0.363, high_threshold=0.5)
    assert confidence_level(0.6, settings) == "HIGH"
    assert confidence_level(0.4, settings) == "MODERATE"
    assert confidence_level(0.2, settings) == "LOW"


# ── privacy: recognize never writes to disk ───────────────────────────────
def test_recognize_writes_nothing_to_disk(fake_embedder, tmp_path, monkeypatch):
    client = make_client(fake_embedder, index_dir=tmp_path / "index")
    enroll(client, "owner", [synthetic_face_image(7)])
    before = {p: p.stat().st_mtime_ns for p in tmp_path.rglob("*")}

    real_open = builtins.open

    def guarded_open(file, mode="r", *args, **kwargs):
        if any(flag in mode for flag in "wax+"):
            raise AssertionError(f"recognize tried to write {file}")
        return real_open(file, mode, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", guarded_open)
    monkeypatch.setattr(cv2, "imwrite", lambda *a, **k: (_ for _ in ()).throw(AssertionError("imwrite called")))

    assert recognize(client, synthetic_face_image(7)).status_code == 200
    assert {p: p.stat().st_mtime_ns for p in tmp_path.rglob("*")} == before


def test_large_frames_are_not_spooled_to_temp_files(fake_embedder, monkeypatch):
    # Starlette spools uploads over 1 MB to a temp file by default; frames must stay in RAM
    client = make_client(fake_embedder)
    big = np.random.default_rng(0).integers(0, 255, (1000, 1000, 3), dtype=np.uint8)
    big[:400, :400] = synthetic_face_image(7)
    payload = png(big)
    assert len(payload) > 1024 * 1024

    def no_temp_files(*args, **kwargs):
        raise AssertionError("upload was spooled to a temporary file on disk")

    monkeypatch.setattr(tempfile, "TemporaryFile", no_temp_files)
    monkeypatch.setattr(tempfile, "NamedTemporaryFile", no_temp_files)
    res = client.post("/api/v1/recognize", files={"frame": ("frame.png", payload, "image/png")})
    assert res.status_code == 200, res.text


# ── index persistence ─────────────────────────────────────────────────────
def test_index_persists_and_reloads(tmp_path):
    vec = np.ones(4, np.float32) / 2
    index = EmbeddingIndex("model-a", tmp_path)
    index.add("owner", vec, "a.jpg")
    reloaded = EmbeddingIndex("model-a", tmp_path)
    assert reloaded.count == 1 and reloaded.search(vec)[0].label == "owner"
    assert not any(name.endswith(".tmp") for name in os.listdir(tmp_path))


def test_index_refuses_embeddings_from_a_different_model(tmp_path):
    EmbeddingIndex("model-a", tmp_path).add("owner", np.ones(4, np.float32), "a.jpg")
    with pytest.raises(IndexModelMismatch):
        EmbeddingIndex("model-b", tmp_path)


def test_index_rejects_mismatched_dimensions():
    index = EmbeddingIndex("m")
    index.add("a", np.ones(4, np.float32), "a")
    with pytest.raises(ValueError):
        index.add("b", np.ones(8, np.float32), "b")


# ── live demo page ────────────────────────────────────────────────────────
def test_live_page_is_off_by_default(fake_embedder):
    assert make_client(fake_embedder).get("/live").status_code == 404


def test_live_page_is_self_contained_when_enabled(fake_embedder):
    client = TestClient(create_app(Settings(index_dir=None, live_demo=True), embedder=fake_embedder))
    res = client.get("/live")
    assert res.status_code == 200 and "getUserMedia" in res.text
    # no external scripts/styles/fonts: frames only ever go to this service
    assert "src=\"http" not in res.text and "href=\"http" not in res.text and "@import" not in res.text
    assert "/api/v1/recognize" in res.text


def test_live_mode_logs_scores_but_not_images(fake_embedder, caplog):
    client = TestClient(create_app(Settings(index_dir=None, live_demo=True), embedder=fake_embedder))
    enroll(client, "owner", [synthetic_face_image(7)])
    with caplog.at_level("INFO", logger="uvicorn.error"):
        recognize(client, synthetic_face_image(7))
        recognize(client, synthetic_face_image(7, faces=0))
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("recognize")]
    assert lines[0].startswith("recognize face=200px top=owner score=") and "level=HIGH" in lines[0]
    assert lines[1].startswith("recognize face=none")
    assert all(len(line) < 200 for line in lines)

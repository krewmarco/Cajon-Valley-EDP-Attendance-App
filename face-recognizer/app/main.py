"""Face recognizer prototype API (see plans/face_recognizer_prototype.md).

Run:  uvicorn app.main:app --port 8000
"""
from __future__ import annotations

import logging
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from starlette.formparsers import MultiPartParser

from .embedder import Embedder, OpenCVSFaceEmbedder
from .images import ImageDecodeError, decode_image
from .index import EmbeddingIndex
from .live import LIVE_PAGE
from .quality import check_enrollment_quality

ROOT = Path(__file__).resolve().parent.parent
log = logging.getLogger("uvicorn.error")
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
STUDENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9-]{1,32}$")


@dataclass
class Settings:
    models_dir: Path = field(default_factory=lambda: Path(os.environ.get("MODELS_DIR", ROOT / "models")))
    index_dir: Path | None = field(default_factory=lambda: Path(os.environ.get("INDEX_DIR", ROOT / "index")))
    # SFace cosine thresholds from reports/evaluation.md (one adult owner vs 500
    # LFW impostors): impostors peaked at 0.383, the owner's held-out photos
    # scored 0.733+. Re-measure on the target population before real use.
    match_threshold: float = float(os.environ.get("MATCH_THRESHOLD", "0.40"))
    high_threshold: float = float(os.environ.get("HIGH_THRESHOLD", "0.60"))
    # Dev-only webcam test page at /live; also logs per-frame scores (never images)
    live_demo: bool = os.environ.get("LIVE_DEMO") == "1"
    # Demo only: serve the fake classroom's card photos (build_demo_class.py)
    demo_gallery: bool = os.environ.get("DEMO_GALLERY") == "1"
    demo_photos_dir: Path = field(default_factory=lambda: Path(os.environ.get("DEMO_PHOTOS_DIR", ROOT / "demo" / "photos")))
    # Browser origins allowed to call the API (the attendance app's dev server)
    allowed_origins: list[str] = field(default_factory=lambda: [
        o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "http://localhost:3000").split(",") if o.strip()
    ])


def confidence_level(score: float, settings: Settings) -> str:
    if score >= settings.high_threshold:
        return "HIGH"
    if score >= settings.match_threshold:
        return "MODERATE"
    return "LOW"


async def read_upload(upload: UploadFile) -> bytes:
    data = await upload.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"{upload.filename}: larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
    return data


def create_app(settings: Settings | None = None, embedder: Embedder | None = None) -> FastAPI:
    # Starlette spools uploads over 1 MB to a temp file on disk; keep anything we
    # accept in RAM so frames are never written to disk (spec §4.1)
    MultiPartParser.spool_max_size = MAX_UPLOAD_BYTES + 1024 * 1024

    settings = settings or Settings()
    embedder = embedder or OpenCVSFaceEmbedder(settings.models_dir)
    index = EmbeddingIndex(embedder.name, settings.index_dir)

    app = FastAPI(title="EDP Face Recognizer (prototype)")
    app.state.index = index
    app.add_middleware(
        CORSMiddleware, allow_origins=settings.allowed_origins, allow_methods=["GET", "POST"], allow_headers=["Content-Type"],
    )

    @app.get("/api/v1/health")
    def health():
        return {
            "status": "ok",
            "model": embedder.name,
            "enrolled_labels": len(index.labels()),
            "enrolled_embeddings": index.count,
            "thresholds": {"match": settings.match_threshold, "high": settings.high_threshold},
        }

    @app.post("/api/v1/enroll")
    async def enroll(label: str = Form(...), photos: list[UploadFile] = File(...)):
        label = label.strip()
        if not label or len(label) > 64:
            raise HTTPException(400, "label must be 1-64 characters")

        accepted, rejected = [], []
        for upload in photos:
            name = os.path.basename(upload.filename or "photo")
            try:
                image = decode_image(await read_upload(upload))
            except ImageDecodeError:
                rejected.append({"file": name, "reason": "unreadable_image"})
                continue
            quality = check_enrollment_quality(image, embedder.detect(image))
            if not quality.ok:
                rejected.append({"file": name, "reason": quality.reason})
                continue
            index.add(label, embedder.embed(image, quality.face), source=name)
            accepted.append(name)

        return {"label": label, "accepted": len(accepted), "rejected": rejected, "accepted_files": accepted}

    @app.post("/api/v1/recognize")
    async def recognize(frame: UploadFile = File(...), max_candidates: int = Form(3)):
        started = time.perf_counter()
        try:
            image = decode_image(await read_upload(frame))
        except ImageDecodeError as err:
            raise HTTPException(400, str(err)) from err

        faces = embedder.detect(image)
        if not faces:
            elapsed = round((time.perf_counter() - started) * 1000, 1)
            if settings.live_demo:
                log.info("recognize face=none ms=%s", elapsed)
            return {"face_detected": False, "bounding_box": None, "candidates": [], "inference_time_ms": elapsed}

        face = faces[0]  # largest face in frame
        matches = index.search(embedder.embed(image, face), k=max(1, min(max_candidates, 10)))
        if settings.live_demo:  # scores only, never images
            top = matches[0] if matches else None
            log.info(
                "recognize face=%dpx top=%s score=%s level=%s ms=%s",
                face.width, top.label if top else "-", f"{top.score:.3f}" if top else "-",
                confidence_level(top.score, settings) if top else "-",
                round((time.perf_counter() - started) * 1000, 1),
            )
        return {
            "face_detected": True,
            "bounding_box": {"x": face.x, "y": face.y, "width": face.width, "height": face.height},
            "candidates": [
                {"label": m.label, "score": round(m.score, 4), "confidence_level": confidence_level(m.score, settings)}
                for m in matches
            ],
            "inference_time_ms": round((time.perf_counter() - started) * 1000, 1),
        }

    @app.get("/api/v1/students/{student_id}/photo", include_in_schema=False)
    def student_photo(student_id: str):
        if not settings.demo_gallery:
            raise HTTPException(404, "Demo gallery is disabled; start the service with DEMO_GALLERY=1")
        if not STUDENT_ID_PATTERN.fullmatch(student_id):
            raise HTTPException(400, "Invalid student id")
        path = settings.demo_photos_dir / f"{student_id}.jpg"
        if not path.is_file():
            raise HTTPException(404, f"No demo photo for '{student_id}'")
        return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=300"})

    @app.get("/live", response_class=HTMLResponse, include_in_schema=False)
    def live_page():
        if not settings.live_demo:
            raise HTTPException(404, "Live demo is disabled; start the service with LIVE_DEMO=1")
        return LIVE_PAGE

    @app.delete("/api/v1/enroll/{label}")
    def delete_label(label: str):
        removed = index.remove(label)
        if not removed:
            raise HTTPException(404, f"No embeddings enrolled for '{label}'")
        return {"label": label, "removed": removed}

    return app


def _default_app() -> FastAPI:
    return create_app()


# `uvicorn app.main:app` — built lazily so importing this module in tests
# doesn't require the model files.
def __getattr__(name: str):
    if name == "app":
        globals()["app"] = _default_app()
        return globals()["app"]
    raise AttributeError(name)

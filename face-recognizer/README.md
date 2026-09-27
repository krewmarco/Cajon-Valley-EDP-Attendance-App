# Face Recognizer Prototype

Standalone, CPU-only face recognition service for measuring whether one enrolled person (the project owner) can be told apart from other people. It follows [`plans/face_recognizer_prototype.md`](../plans/face_recognizer_prototype.md); read the **Status & Corrections** section of [`docs/face-recognizer.md`](../docs/face-recognizer.md) first.

**Not integrated with the attendance app. No student data, ever.**

## Privacy rules

- `data/` (photos, LFW), `index/` (enrolled embeddings), and `models/` are **git-ignored**. The repo is public, so never commit anything from them. Check `git status` before committing.
- Embeddings are biometric data (they can identify a person). Remove them with `python scripts/enroll.py --delete owner` or `DELETE /api/v1/enroll/owner`.
- `/recognize` decodes frames in memory and never writes them to disk. Uploads up to 15 MB stay in RAM, and a test checks both of these.
- `reports/evaluation.md` contains aggregate numbers only. Per-file details go to `reports/evaluation.local.md`, which is git-ignored.

## Models

| Stage | Model | License |
|---|---|---|
| Detection | OpenCV YuNet `face_detection_yunet_2023mar.onnx` | MIT |
| Embedding | OpenCV SFace `face_recognition_sface_2021dec.onnx` (128-d) | Apache-2.0 |

InsightFace (`buffalo_l`, named in the spec) is licensed for non-commercial research only. Models sit behind `app/embedder.py`'s `Embedder` interface, so others can be benchmarked later.

## Setup

```bash
cd face-recognizer
uv venv -p 3.11 .venv && uv pip install -p .venv -r requirements-dev.txt
.venv/bin/python scripts/download_models.py        # ~39 MB, SHA-256 verified
```

LFW (public photos of other people, used as impostors) is about 200 MB. Download it once:

```bash
.venv/bin/python -c "from sklearn.datasets._lfw import _check_fetch_lfw; _check_fetch_lfw(data_home='data/lfw', funneled=False)"
```

## Evaluate: can it recognize me?

1. Put 10–20 photos of yourself in `data/owner/`: one face per photo, varied angles and lighting, different days. JPEG, PNG, and iPhone HEIC all work.
2. Run:
   ```bash
   .venv/bin/python scripts/evaluate.py
   ```
   It splits your photos with a fixed seed (60% enroll, 40% held-out), scores the held-out photos and 500 LFW impostors, and writes `reports/evaluation.md`. That report has a threshold table (owner recognized vs. impostor falsely matched) and a recommended threshold.

## Run the service

```bash
.venv/bin/python scripts/enroll.py --label owner data/owner     # enroll into index/
.venv/bin/uvicorn app.main:app --port 8000                     # or: docker build -t edp-face-recognizer . && docker run -p 8000:8000 -v "$PWD/index:/app/index" edp-face-recognizer

curl -s localhost:8000/api/v1/health
curl -s -F frame=@some-photo.jpg localhost:8000/api/v1/recognize
```

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/health` | model, enrolled label/embedding counts, thresholds |
| `POST /api/v1/enroll` (`label`, `photos[]`) | quality-gated enrollment; returns reasons for each rejection |
| `POST /api/v1/recognize` (`frame`, `max_candidates`) | top matches with `score` and `confidence_level` |
| `DELETE /api/v1/enroll/{label}` | delete a label's embeddings |

Thresholds come from `MATCH_THRESHOLD` / `HIGH_THRESHOLD`, with defaults **0.40 / 0.60** from [`reports/evaluation.md`](reports/evaluation.md). They are measured on one adult, so re-measure before any other use.

## Live webcam test (dev only)

```bash
.venv/bin/python scripts/enroll.py --label owner data/owner
LIVE_DEMO=1 .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
# open http://localhost:8000/live and allow the camera
```

The page captures a frame every 500 ms in the browser, posts it to `/api/v1/recognize`, and draws the face box with the top match, score, and level, plus running stats. Frames are scored in memory and discarded. With `LIVE_DEMO=1` the server logs one line per frame (`face=<px> top=<label> score=<s> level=<L> ms=<t>`, **no images**). `/live` returns 404 unless `LIVE_DEMO=1`. Bind to `127.0.0.1` so it isn't reachable from the network.

First session (owner only, varied poses and lighting): 74 frames, 67 with a face detected, of which 59 HIGH, 8 MODERATE, 0 below the 0.40 match threshold. Scores 0.478–0.792 (median 0.700), about 36 ms per frame on the server. **There's no liveness check:** a photo of an enrolled person held up to the camera is expected to match.

## Detection scale

YuNet runs on a copy downscaled to 640 px on the long side, and the box and landmarks are mapped back, so alignment and embedding use full resolution. On full-size (1600 px) iPhone portraits, the owner's large faces scored 0.84–0.90, just under the 0.9 detection cutoff, so 11 of 12 went undetected. At 640 px they score 0.91–0.94, with no extra faces and no change on LFW.

## Quality gates (enrollment)

- Exactly one face.
- Face at least 112 × 112 px.
- Sharpness at least **40**: variance of the Laplacian over the face resized to 112 × 112, so the score doesn't depend on resolution. This was measured on 150 LFW faces: sharp originals p5 = 48, Gaussian-blurred (σ 1.5) p95 = 39. The spec's value of 100 would reject about half of sharp photos on this scale.

## Tests

```bash
.venv/bin/python -m pytest -q
```

Service tests use a fake embedder with synthetic images, so no real faces are committed. `tests/test_real_models.py` runs the real models on local LFW photos and skips if they haven't been downloaded.

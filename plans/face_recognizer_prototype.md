# Face Recognizer Prototype — Session Brief

> **For:** a Claude Code session (recommended model: **Opus 5.5**), run **locally** on the owner's Mac in the git worktree `../edp-face-recognizer`
> **Branch:** `feat/face-recognizer-prototype` (from `main`)
> **Spec:** [`docs/face-recognizer.md`](../docs/face-recognizer.md). Read its **Status & Corrections** section first; it overrides parts of the spec.

## Goal

Build a standalone, CPU-only face recognition service. Then show, with measured numbers, whether it can tell **the project owner's face** apart from other people's faces using still photos.

- The owner will provide 10–20 photos of themselves. **The only real person enrolled is the owner, with their consent.**
- This is a **prototype and measurement exercise.** It is not integrated into the attendance app.
- **No training.** A pretrained model turns each face into an embedding. Enrollment stores embeddings, and recognition compares against them by cosine similarity.

## Hard rules (never break these)

1. **Never commit any face photo or embedding.** The repo and its fork are **public**. Photos go in `face-recognizer/data/` and embeddings in `face-recognizer/index/`. Both must be git-ignored *before* any photo exists. Run `git status` before every commit and confirm that no image or `.npy`/`.json` index files are staged.
2. **No student data, ever**, including names from the mock data used alongside face photos. The only enrolled identity is the owner: `owner` or a label they choose.
3. **No third-party face APIs**, such as a cloud vision service. Inference runs locally on this machine.
4. **Don't print, log, or write the owner's photos or embeddings** outside those two ignored folders. Reports contain only aggregate numbers and file *names*.
5. **Don't push model weights to git.** Download them with a script and verify their checksums.
6. **Stay inside `face-recognizer/`** and the two docs listed under Deliverables. Don't modify `src/`, `scanner/`, or other app code.

## Getting the owner's photos

The owner copies 10–20 photos into **`face-recognizer/data/owner/`**, a local, git-ignored folder. Photos never leave the machine.
- **The assistant must not open the photos** with its file-reading tool; that would send them off the machine. Only the local model reads them. The assistant works from aggregate outputs and file names.
- Useful photos: one face each, varied (frontal and slight angles, indoor and outdoor light, glasses on/off if applicable, different days).
- `scripts/evaluate.py` splits them deterministically (fixed seed): about 60% **enroll**, about 40% **held-out test**. Enrollment never sees the held-out photos.
- If the folder is empty, build Milestones 1–3 first, then ask.

## Technical choices (already decided)

| Concern | Choice | Why |
|---|---|---|
| Face detection | OpenCV **YuNet** (`face_detection_yunet_2023mar.onnx`, MIT) | Small, CPU-fast, permissive license |
| Face embedding | OpenCV **SFace** (`face_recognition_sface_2021dec.onnx`, Apache-2.0) | Permissive license; the spec's InsightFace `buffalo_l` is **non-commercial research only** |
| API | Python 3.11 + FastAPI + Uvicorn | Matches the spec |
| Index | NumPy array + JSON metadata on disk (git-ignored) | One identity doesn't need ChromaDB/FAISS; keep it behind an interface |
| Packaging | `Dockerfile` + `requirements.txt` with pinned versions | Reproducible |

Model files come from the `opencv/opencv_zoo` GitHub repo (`models/face_detection_yunet/` and `models/face_recognition_sface/`). Write `scripts/download_models.py`: download into `face-recognizer/models/` (git-ignored), record the SHA-256 in the script, and fail clearly if a download is blocked. **If the sandbox blocks the download**, stop and tell the owner which URL failed. Don't substitute a different model on your own.

OpenCV API: `cv2.FaceDetectorYN.create(...)`, then `cv2.FaceRecognizerSF.create(...)`, then `recognizer.alignCrop(img, face_row)`, then `recognizer.feature(aligned)`. OpenCV's reference cosine threshold for SFace is about **0.363** for "same person". The spec's 0.74 / 0.58 are ArcFace-style guesses and **do not apply**. Thresholds come from measurement (Milestone 4).

Put the embedder behind a small interface (`Embedder` with `detect()`/`embed()`), so InsightFace or another model can be benchmarked later without rewriting the service.

## Layout

```
face-recognizer/
├── README.md               # how to run, how to enroll, what the results mean
├── Dockerfile
├── requirements.txt
├── .gitignore              # data/, index/, models/, reports/*.local.*
├── app/
│   ├── main.py             # FastAPI app
│   ├── embedder.py         # Embedder interface + OpenCV YuNet/SFace implementation
│   ├── quality.py          # quality gates
│   └── index.py            # enrolled-embedding store (NumPy + JSON)
├── scripts/
│   ├── download_models.py
│   ├── enroll.py           # CLI: enroll a folder of photos under a label
│   └── evaluate.py         # CLI: score held-out + impostor photos, write report
└── tests/                  # pytest; synthetic/generated images only, no real faces committed
```

## API

- `POST /api/v1/enroll` (multipart: `label`, one or more `photos`). Runs the quality gates per photo, stores one embedding per accepted photo, and returns accepted/rejected counts with a reason for each rejection.
- `POST /api/v1/recognize` (multipart: `frame`, optional `max_candidates` = 3). Returns `face_detected`, `bounding_box`, `inference_time_ms`, and `candidates[]` with `label`, `score` (the best score across that label's enrolled embeddings) and `confidence_level`.
- `GET /api/v1/health` returns model names, enrolled label count, and embedding count. No biometric data.
- `DELETE /api/v1/enroll/{label}` removes a label's embeddings. The owner must be able to delete their data.

**Quality gates** (from spec §2.3): exactly one face; face box ≥ 112×112 px; sharpness (Laplacian variance) ≥ 100. Add yaw/pitch rejection only if you can estimate it simply from YuNet's landmarks. Otherwise note it as future work.

**Frames are not written to disk** during `/recognize` (spec §4.1): decode in memory and discard.

## Milestones (in order; commit after each)

1. **Scaffold + models:** `.gitignore` first, then the layout, the download script, and Docker. The service starts and `/health` responds.
2. **Pipeline with tests (no real faces needed):** quality gates, embedder, index, and endpoints. Test with generated images (e.g., blank/noise images for "no face", resized crops for the size gate), plus a test that nothing is written to disk during `/recognize`.
3. **Impostor set:** a public face dataset of *other people* for measuring false matches. Prefer LFW (Labeled Faces in the Wild), e.g. via `sklearn.datasets.fetch_lfw_people`, downloaded into the ignored `data/` folder. Use a few hundred images across many identities. If it can't be downloaded, say so and ask the owner. Don't scrape the web.
4. **Enroll the owner and evaluate** (needs the owner's photos). `scripts/evaluate.py` writes `face-recognizer/reports/evaluation.md` (committable, **aggregate numbers only**), containing:
   - counts: enrolled, held-out genuine, impostor, and quality-gate rejections with reasons
   - genuine scores (owner held-out vs. enrolled): min, mean, max
   - impostor scores (LFW vs. owner): min, mean, max, 99th percentile
   - a threshold table: for thresholds 0.30–0.60 in steps of 0.05, the genuine accept rate and the impostor false-accept rate
   - a recommended threshold with reasoning, and the median inference time on CPU
   - honest limitations: one adult subject, not children; still photos; the dataset's demographics
5. **Report back:** a summary in the session's final message, plus a short "Prototype Results" section appended to `docs/face-recognizer.md` that links to the report.

## Definition of done

- `docker build` succeeds. `pytest` passes. The service starts and `/health` responds.
- Milestones 1–3 complete. Milestone 4 complete **if the owner's photos were provided**; otherwise everything is ready and the README says exactly how to run it.
- `git log -p` for the branch contains **no images, embeddings, or model weights** (check before pushing).
- The branch is pushed to the owner's fork (`krewmarco/Cajon-Valley-EDP-Attendance-App`). **Don't open a PR and don't merge anything.** The owner will review first.

## Stop and ask the owner (don't guess) when

- photos aren't available and everything else is done
- a model or dataset download is blocked
- something would require breaking a hard rule
- results look wrong: e.g. impostor scores overlapping heavily with genuine ones, which could point to a bug (misaligned crops, BGR vs. RGB) rather than the model

## Optional bonus (after Milestone 5)

**Live webcam check:** a minimal local page or script that grabs frames from the Mac's camera and shows the top match and score. It must follow the same rules: frames stay in memory, and nothing is written or committed.

## Out of scope tonight

Integration with the attendance app, Supabase, the audit trail, the scanner dongle, children's photos, GPU/TensorRT, InsightFace (future benchmark only), and deployment anywhere.

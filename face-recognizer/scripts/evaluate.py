#!/usr/bin/env python3
"""Measure how well the owner is recognized versus other people.

- Owner photos (data/owner/) are split with a fixed seed into enroll / held-out.
- Enroll photos pass the quality gates; held-out photos go through the
  recognition path (largest face, no gates), like a live frame would.
- Impostors are LFW photos of other people (data/lfw/...), one per identity.

Writes:
  reports/evaluation.md          aggregate numbers only (committable)
  reports/evaluation.local.md    per-file names and scores (git-ignored)
Photos and embeddings never leave memory; nothing biometric is written.
"""
from __future__ import annotations

import argparse
import random
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.embedder import OpenCVSFaceEmbedder  # noqa: E402
from app.images import ImageDecodeError, decode_image  # noqa: E402
from app.quality import check_enrollment_quality  # noqa: E402

PHOTO_SUFFIXES = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}
THRESHOLDS = [round(0.30 + 0.05 * i, 2) for i in range(7)]  # 0.30 .. 0.60
LFW_UPSCALE = 2  # LFW faces are ~90-110 px; upscale so detection matches phone-photo scale


@dataclass
class Scored:
    name: str
    score: float | None  # None = no face found
    note: str = ""


@dataclass
class Results:
    enrolled: list[str] = field(default_factory=list)
    enroll_rejected: list[tuple[str, str]] = field(default_factory=list)
    genuine: list[Scored] = field(default_factory=list)
    impostor: list[Scored] = field(default_factory=list)
    timings_ms: list[float] = field(default_factory=list)


def owner_photos(folder: Path) -> list[Path]:
    return sorted(p for p in folder.iterdir() if p.suffix.lower() in PHOTO_SUFFIXES)


def split(photos: list[Path], enroll_fraction: float, seed: int) -> tuple[list[Path], list[Path]]:
    shuffled = photos[:]
    random.Random(seed).shuffle(shuffled)
    n_enroll = max(1, min(len(shuffled) - 1, round(len(shuffled) * enroll_fraction)))
    return shuffled[:n_enroll], shuffled[n_enroll:]


def best_score(vector: np.ndarray, enrolled: np.ndarray) -> float:
    return float(np.max(enrolled @ vector))


def score_photo(embedder, image: np.ndarray, enrolled: np.ndarray, timings: list[float]) -> float | None:
    started = time.perf_counter()
    faces = embedder.detect(image)
    if not faces:
        return None
    vector = embedder.embed(image, faces[0])
    timings.append((time.perf_counter() - started) * 1000)
    return best_score(vector, enrolled)


def run(args: argparse.Namespace) -> Results:
    embedder = OpenCVSFaceEmbedder(args.models_dir)
    results = Results()

    photos = owner_photos(args.owner_dir)
    if len(photos) < 2:
        sys.exit(f"Need at least 2 photos in {args.owner_dir} (found {len(photos)}); 10-20 recommended.")
    enroll_set, test_set = split(photos, args.enroll_fraction, args.seed)

    vectors = []
    for path in enroll_set:
        try:
            image = decode_image(path.read_bytes())
        except ImageDecodeError:
            results.enroll_rejected.append((path.name, "unreadable_image"))
            continue
        quality = check_enrollment_quality(image, embedder.detect(image))
        if not quality.ok:
            results.enroll_rejected.append((path.name, quality.reason))
            continue
        vectors.append(embedder.embed(image, quality.face))
        results.enrolled.append(path.name)
    if not vectors:
        details = "\n".join(f"  {name}: {reason}" for name, reason in results.enroll_rejected)
        sys.exit(f"No enrollment photo passed the quality gates:\n{details}")
    enrolled = np.stack(vectors)

    for path in test_set:
        try:
            image = decode_image(path.read_bytes())
        except ImageDecodeError:
            results.genuine.append(Scored(path.name, None, "unreadable_image"))
            continue
        results.genuine.append(Scored(path.name, score_photo(embedder, image, enrolled, results.timings_ms)))

    identities = sorted(p for p in args.lfw_dir.iterdir() if p.is_dir())
    random.Random(args.seed).shuffle(identities)
    for person in identities[: args.impostors]:
        path = sorted(person.glob("*.jpg"))[0]
        image = decode_image(path.read_bytes())
        image = cv2.resize(image, None, fx=LFW_UPSCALE, fy=LFW_UPSCALE, interpolation=cv2.INTER_CUBIC)
        results.impostor.append(Scored(person.name, score_photo(embedder, image, enrolled, results.timings_ms)))

    return results


def rate(values: list[bool]) -> str:
    return f"{100 * np.mean(values):.1f}%" if values else "n/a"


def stats(scores: np.ndarray) -> str:
    if scores.size == 0:
        return "n/a"
    return f"min {scores.min():.3f} · mean {scores.mean():.3f} · max {scores.max():.3f}"


def recommend(genuine: np.ndarray, impostor: np.ndarray) -> tuple[float | None, str]:
    """Lowest table threshold with no observed false accepts."""
    for threshold in THRESHOLDS:
        if impostor.size and np.all(impostor < threshold):
            accept = np.mean(genuine >= threshold) if genuine.size else 0.0
            return threshold, (
                f"**{threshold:.2f}** is the lowest threshold with **no** false accepts among {impostor.size} impostors, "
                f"while accepting {100 * accept:.0f}% of held-out owner photos. Zero observed false accepts is not a "
                f"zero rate: with {impostor.size} impostors, the 95% upper bound is about {300 / impostor.size:.1f}% "
                f"(rule of three)."
            )
    return None, "No threshold in the table separates owner and impostors; inspect the local report."


def write_reports(args: argparse.Namespace, r: Results) -> None:
    genuine = np.array([s.score for s in r.genuine if s.score is not None])
    impostor = np.array([s.score for s in r.impostor if s.score is not None])
    genuine_no_face = sum(s.score is None for s in r.genuine)
    impostor_no_face = sum(s.score is None for s in r.impostor)
    threshold, reasoning = recommend(genuine, impostor)

    rows = []
    for t in THRESHOLDS:
        # A held-out photo with no detected face counts as not recognized
        gar = [s.score is not None and s.score >= t for s in r.genuine]
        far = [s >= t for s in impostor]
        rows.append(f"| {t:.2f} | {rate(gar)} | {rate(far)} | {sum(far)} |")

    reasons: dict[str, int] = {}
    for _, reason in r.enroll_rejected:
        reasons[reason] = reasons.get(reason, 0) + 1

    report = f"""# Face Recognizer Prototype — Evaluation

_Generated {datetime.now().strftime('%Y-%m-%d %H:%M')} by `scripts/evaluate.py` (seed {args.seed}). Aggregate numbers only; no images, embeddings, or file names._

**Model:** OpenCV YuNet (detection) + SFace (embedding), CPU.
**Subject:** one adult (the project owner, with consent) versus LFW photos of other people.

## Data

| | Count |
|---|---|
| Owner photos provided | {len(r.enrolled) + len(r.enroll_rejected) + len(r.genuine)} |
| Enrolled (passed quality gates) | {len(r.enrolled)} |
| Enrollment rejections | {len(r.enroll_rejected)}{' (' + ', '.join(f'{k}: {v}' for k, v in sorted(reasons.items())) + ')' if reasons else ''} |
| Held-out owner photos (genuine) | {len(r.genuine)} ({genuine_no_face} with no face detected) |
| Impostor photos (LFW, one per identity) | {len(r.impostor)} ({impostor_no_face} with no face detected) |

## Scores (cosine similarity to the owner's closest enrolled photo)

- **Genuine** (owner, held-out): {stats(genuine)}
- **Impostor** (other people): {stats(impostor)}{f" · 99th percentile {np.percentile(impostor, 99):.3f}" if impostor.size else ""}

## Threshold table

| Threshold | Owner recognized (genuine accept) | Impostor falsely matched (false accept) | False accepts |
|---|---|---|---|
{chr(10).join(rows)}

## Recommendation

{reasoning}

For the human-in-the-loop design, a false accept means a wrong candidate is *suggested* to the attendant, not an automatic check-in. The HIGH/MODERATE badge thresholds should sit at or above this value.

Median detect + embed time: **{np.median(r.timings_ms):.0f} ms** per photo on this machine's CPU.

## Limitations

- **One adult subject.** Children's faces behave differently and change over a school year; this says nothing about accuracy on students.
- **Still photos** taken by the owner, not live frames at a check-in podium (motion, lighting, angles).
- **LFW** is mostly adult public figures, and its demographics skew toward white men; the impostor scores may not represent a school population.
- {len(r.impostor)} impostors bounds the false-accept rate only coarsely (see the rule-of-three note above).
- A threshold chosen on this data should be re-measured on the target population before any real use.
"""
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(report)

    local = ["# Evaluation — per-file details (LOCAL ONLY, git-ignored)", "", "## Enrollment", ""]
    local += [f"- enrolled: {name}" for name in r.enrolled]
    local += [f"- rejected: {name} ({reason})" for name, reason in r.enroll_rejected]
    local += ["", "## Held-out owner photos", ""]
    local += [f"- {s.name}: {'no face' if s.score is None else f'{s.score:.3f}'} {s.note}".rstrip() for s in sorted(r.genuine, key=lambda s: -1 if s.score is None else s.score)]
    local += ["", "## Top 10 impostor scores", ""]
    top = sorted((s for s in r.impostor if s.score is not None), key=lambda s: s.score, reverse=True)[:10]
    local += [f"- {s.name}: {s.score:.3f}" for s in top]
    args.local_report.write_text("\n".join(local) + "\n")

    print(report)
    print(f"Per-file details: {args.local_report} (git-ignored)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--owner-dir", type=Path, default=ROOT / "data" / "owner")
    parser.add_argument("--lfw-dir", type=Path, default=ROOT / "data" / "lfw" / "lfw_home" / "lfw")
    parser.add_argument("--models-dir", type=Path, default=ROOT / "models")
    parser.add_argument("--impostors", type=int, default=500)
    parser.add_argument("--enroll-fraction", type=float, default=0.6)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--report", type=Path, default=ROOT / "reports" / "evaluation.md")
    parser.add_argument("--local-report", type=Path, default=ROOT / "reports" / "evaluation.local.md")
    args = parser.parse_args()
    write_reports(args, run(args))


if __name__ == "__main__":
    main()

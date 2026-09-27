#!/usr/bin/env python3
"""Build the fake demo classroom (plans/demo_face_checkin_plan.md, step 2).

Students: N people from LFW who have exactly ONE photo there (mostly not
public figures), shown under invented names. Developers: consenting adults
whose photos are in data/developers/<slug>/ and described in
demo/developers.json. Nothing here is real student data.

Outputs (all git-ignored, local only):
  demo/photos/<elop_id>.jpg    256px face-centered "yearbook" thumbnails
  demo/roster.json             roster incl. each LFW identity (for --exclude)
  ../supabase/seed.demo.sql    public.students rows for local Supabase
  index/                       face embeddings, label = ELOP ID (rebuilt)

Exclude a recognizable face: add its ELOP ID (from the current roster) or LFW
identity to demo/exclude.txt and re-run; IDs are resolved to identities so the
exclusion survives rebuilds.
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.embedder import DetectedFace, OpenCVSFaceEmbedder  # noqa: E402
from app.images import ImageDecodeError, decode_image  # noqa: E402
from app.index import EmbeddingIndex  # noqa: E402
from app.quality import check_enrollment_quality, face_sharpness  # noqa: E402

PHOTO_SUFFIXES = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}
GRADES = ["TK", "K", "1", "2", "3", "4", "5"]
FIRST_ELOP_ID = 3001
THUMB_PX = 256
LFW_UPSCALE = 2
PHOTO_URL = "http://localhost:8000/api/v1/students/{elop_id}/photo"

# Invented names; any resemblance to the pictured people is coincidental
FIRST_NAMES = [
    "Avery", "Blake", "Camila", "Dana", "Elena", "Felix", "Gia", "Hector", "Iris", "Jonah",
    "Kira", "Leo", "Maya", "Nico", "Olive", "Parker", "Quinn", "Rosa", "Sami", "Theo",
    "Uma", "Vera", "Wes", "Ximena", "Yusuf", "Zara", "Aiden", "Bea", "Cyrus", "Dahlia",
    "Emil", "Farah", "Gus", "Hana", "Isaac", "June", "Kai", "Luz", "Milo", "Nora",
]
LAST_NAMES = [
    "Alvarez", "Brooks", "Castillo", "Dang", "Ellis", "Flores", "Garza", "Hughes", "Ibarra", "Jensen",
    "Kaur", "Lopez", "Morales", "Nguyen", "Ortiz", "Patel", "Quintero", "Reyes", "Silva", "Tran",
    "Underwood", "Vargas", "Watts", "Yamada", "Zamora", "Bishop", "Carver", "Delgado", "Fischer", "Holt",
]


@dataclass
class RosterEntry:
    elop_id: str
    first_name: str
    last_name: str
    grade: str
    programs: list[str]
    source: str                      # "lfw" | "developer"
    lfw_identity: str | None = None  # local only; used to keep exclusions stable
    developer_slug: str | None = None
    enrolled_embeddings: int = 0


@dataclass
class BuildReport:
    lfw_considered: int = 0
    lfw_rejected: dict[str, int] = field(default_factory=dict)
    developer_rejected: dict[str, dict[str, int]] = field(default_factory=dict)


def thumbnail(image: np.ndarray, face: DetectedFace, size: int = THUMB_PX) -> np.ndarray:
    """Square crop centered on the face (2x its size), padded at the edges."""
    cx, cy = face.x + face.width / 2, face.y + face.height / 2
    half = int(max(face.width, face.height))
    pad = cv2.copyMakeBorder(image, half, half, half, half, cv2.BORDER_REPLICATE)
    cx, cy = int(cx) + half, int(cy) + half
    crop = pad[cy - half: cy + half, cx - half: cx + half]
    return cv2.resize(crop, (size, size), interpolation=cv2.INTER_AREA)


def load_developers(path: Path) -> list[dict]:
    if not path.exists():
        return []
    developers = json.loads(path.read_text())
    for dev in developers:
        for key in ("slug", "first_name", "last_name", "grade"):
            if not dev.get(key):
                sys.exit(f"{path}: each developer needs '{key}'")
        if dev["grade"] not in GRADES:
            sys.exit(f"{path}: grade must be one of {GRADES}")
    return developers


def resolve_exclusions(path: Path, previous_roster: list[dict]) -> set[str]:
    """Exclude file lines are LFW identities or ELOP IDs from the previous
    roster; IDs are rewritten as identities so they stay excluded."""
    if not path.exists():
        return set()
    by_id = {r["elop_id"]: r.get("lfw_identity") for r in previous_roster}
    identities = set()
    for line in path.read_text().splitlines():
        entry = line.split("#")[0].strip()
        if not entry:
            continue
        identities.add(by_id.get(entry) or entry)
    identities.discard(None)
    path.write_text("# LFW identities excluded from the demo roster\n" + "\n".join(sorted(identities)) + "\n")
    return identities


def invented_names(count: int, rng: random.Random) -> list[tuple[str, str]]:
    pairs = [(f, l) for f in FIRST_NAMES for l in LAST_NAMES]
    rng.shuffle(pairs)
    return pairs[:count]


def sql_literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, list):
        return "ARRAY[" + ", ".join(sql_literal(v) for v in value) + "]::text[]"
    return "'" + str(value).replace("'", "''") + "'"


def write_seed(roster: list[RosterEntry], path: Path) -> None:
    rows = []
    for r in roster:
        rows.append(
            "(" + ", ".join([
                sql_literal(r.first_name), sql_literal(r.last_name), sql_literal(r.grade),
                sql_literal(r.elop_id), sql_literal(f"A{r.elop_id}" if "ASES" in r.programs else None),
                sql_literal(r.programs), sql_literal(PHOTO_URL.format(elop_id=r.elop_id)),
            ]) + ")"
        )
    path.write_text(
        "-- GENERATED by face-recognizer/scripts/build_demo_class.py — demo roster, not real students.\n"
        "-- Git-ignored. Loaded by `supabase db reset`.\n"
        "TRUNCATE public.students CASCADE;\n"
        "INSERT INTO public.students (first_name, last_name, grade, elop_id, ases_id, programs, yearbook_photo_url) VALUES\n"
        + ",\n".join(rows) + ";\n"
    )


def build(args: argparse.Namespace) -> tuple[list[RosterEntry], BuildReport]:
    rng = random.Random(args.seed)
    embedder = OpenCVSFaceEmbedder(args.models_dir)
    report = BuildReport()
    demo_dir: Path = args.demo_dir
    photos_dir = demo_dir / "photos"
    previous = json.loads((demo_dir / "roster.json").read_text()) if (demo_dir / "roster.json").exists() else []
    excluded = resolve_exclusions(demo_dir / "exclude.txt", previous)
    developers = load_developers(demo_dir / "developers.json")

    # Clean rebuild of generated artifacts
    shutil.rmtree(photos_dir, ignore_errors=True)
    photos_dir.mkdir(parents=True)
    shutil.rmtree(args.index_dir, ignore_errors=True)
    index = EmbeddingIndex(embedder.name, args.index_dir)

    total = args.students + len(developers)
    names = invented_names(total, rng)
    grades = [GRADES[i % len(GRADES)] for i in range(total)]
    rng.shuffle(grades)
    elop_ids = [str(FIRST_ELOP_ID + i) for i in range(total)]
    roster: list[RosterEntry] = []

    # ── Fake students from single-photo LFW identities ─────────────────────
    identities = sorted(p for p in args.lfw_dir.iterdir() if p.is_dir() and len(list(p.glob("*.jpg"))) == 1)
    rng.shuffle(identities)
    for person in identities:
        if len(roster) == args.students:
            break
        if person.name in excluded:
            continue
        report.lfw_considered += 1
        image = decode_image(next(person.glob("*.jpg")).read_bytes())
        image = cv2.resize(image, None, fx=LFW_UPSCALE, fy=LFW_UPSCALE, interpolation=cv2.INTER_CUBIC)
        quality = check_enrollment_quality(image, embedder.detect(image))
        if not quality.ok:
            report.lfw_rejected[quality.reason] = report.lfw_rejected.get(quality.reason, 0) + 1
            continue
        i = len(roster)
        entry = RosterEntry(
            elop_id=elop_ids[i], first_name=names[i][0], last_name=names[i][1], grade=grades[i],
            programs=["ELOP", "ASES"] if rng.random() < 0.4 else ["ELOP"], source="lfw", lfw_identity=person.name,
        )
        index.add(entry.elop_id, embedder.embed(image, quality.face), source="lfw")
        cv2.imwrite(str(photos_dir / f"{entry.elop_id}.jpg"), thumbnail(image, quality.face), [cv2.IMWRITE_JPEG_QUALITY, 90])
        entry.enrolled_embeddings = 1
        roster.append(entry)
    if len(roster) < args.students:
        sys.exit(f"Only {len(roster)} LFW identities passed the quality gates (wanted {args.students})")

    # ── Developers (consenting adults; photos never leave this machine) ─────
    for dev in developers:
        folder = args.developers_dir / dev["slug"]
        photos = sorted(p for p in folder.iterdir() if p.suffix.lower() in PHOTO_SUFFIXES) if folder.exists() else []
        if not photos:
            sys.exit(f"No photos in {folder} for developer '{dev['slug']}'")
        i = len(roster)
        entry = RosterEntry(
            elop_id=elop_ids[i], first_name=dev["first_name"], last_name=dev["last_name"], grade=dev["grade"],
            programs=dev.get("programs", ["ELOP"]), source="developer", developer_slug=dev["slug"],
        )
        rejected: dict[str, int] = {}
        best = None  # (sharpness, image, face) for the yearbook photo
        for path in photos:
            try:
                image = decode_image(path.read_bytes())
            except ImageDecodeError:
                rejected["unreadable_image"] = rejected.get("unreadable_image", 0) + 1
                continue
            quality = check_enrollment_quality(image, embedder.detect(image))
            if not quality.ok:
                rejected[quality.reason] = rejected.get(quality.reason, 0) + 1
                continue
            index.add(entry.elop_id, embedder.embed(image, quality.face), source="developer")
            entry.enrolled_embeddings += 1
            is_chosen = dev.get("yearbook_photo") == path.name
            score = float("inf") if is_chosen else face_sharpness(image, quality.face)
            if best is None or score > best[0]:
                best = (score, image, quality.face)
        if not best:
            sys.exit(f"No photo of developer '{dev['slug']}' passed the quality gates: {rejected}")
        cv2.imwrite(str(photos_dir / f"{entry.elop_id}.jpg"), thumbnail(best[1], best[2]), [cv2.IMWRITE_JPEG_QUALITY, 90])
        report.developer_rejected[dev["slug"]] = rejected
        roster.append(entry)

    (demo_dir / "roster.json").write_text(json.dumps([asdict(r) for r in roster], indent=2))
    write_seed(roster, args.seed_file)
    return roster, report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--students", type=int, default=30)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--demo-dir", type=Path, default=ROOT / "demo")
    parser.add_argument("--developers-dir", type=Path, default=ROOT / "data" / "developers")
    parser.add_argument("--lfw-dir", type=Path, default=ROOT / "data" / "lfw" / "lfw_home" / "lfw")
    parser.add_argument("--models-dir", type=Path, default=ROOT / "models")
    parser.add_argument("--index-dir", type=Path, default=ROOT / "index")
    parser.add_argument("--seed-file", type=Path, default=ROOT.parent / "supabase" / "seed.demo.sql")
    args = parser.parse_args()

    roster, report = build(args)
    developers = [r for r in roster if r.source == "developer"]
    print(f"Roster: {len(roster)} ({len(roster) - len(developers)} LFW stand-ins + {len(developers)} developers)")
    print(f"LFW: considered {report.lfw_considered}, rejected {report.lfw_rejected or 'none'}")
    for dev in developers:
        print(f"Developer {dev.developer_slug}: ELOP {dev.elop_id}, {dev.enrolled_embeddings} photos enrolled, "
              f"rejected {report.developer_rejected[dev.developer_slug] or 'none'}")
    if not developers:
        print("No developers enrolled — add demo/developers.json (see demo.developers.example.json)")
    print(f"Wrote {args.demo_dir / 'photos'}/, {args.demo_dir / 'roster.json'}, {args.seed_file}, index at {args.index_dir}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Enroll a folder of photos under a label into the service's index
(index/, git-ignored), applying the same quality gates as POST /api/v1/enroll.

  python scripts/enroll.py --label owner data/owner
  python scripts/enroll.py --delete owner          # remove the label's embeddings
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.embedder import OpenCVSFaceEmbedder  # noqa: E402
from app.images import ImageDecodeError, decode_image  # noqa: E402
from app.index import EmbeddingIndex  # noqa: E402
from app.quality import check_enrollment_quality  # noqa: E402

PHOTO_SUFFIXES = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folder", nargs="?", type=Path)
    parser.add_argument("--label", default="owner")
    parser.add_argument("--delete", metavar="LABEL")
    parser.add_argument("--models-dir", type=Path, default=ROOT / "models")
    parser.add_argument("--index-dir", type=Path, default=ROOT / "index")
    args = parser.parse_args()

    embedder = OpenCVSFaceEmbedder(args.models_dir)
    index = EmbeddingIndex(embedder.name, args.index_dir)

    if args.delete:
        print(f"removed {index.remove(args.delete)} embeddings for '{args.delete}'")
        return 0
    if not args.folder:
        parser.error("folder is required unless --delete is given")

    accepted = 0
    for path in sorted(p for p in args.folder.iterdir() if p.suffix.lower() in PHOTO_SUFFIXES):
        try:
            image = decode_image(path.read_bytes())
        except ImageDecodeError:
            print(f"rejected {path.name}: unreadable_image")
            continue
        quality = check_enrollment_quality(image, embedder.detect(image))
        if not quality.ok:
            print(f"rejected {path.name}: {quality.reason}")
            continue
        index.add(args.label, embedder.embed(image, quality.face), source=path.name)
        accepted += 1
    print(f"enrolled {accepted} photos as '{args.label}' ({index.count} embeddings in index)")
    return 0 if accepted else 1


if __name__ == "__main__":
    sys.exit(main())

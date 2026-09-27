from __future__ import annotations

import importlib.util
import json
import random
import sys
from pathlib import Path

import numpy as np
import pytest

from app.embedder import DetectedFace

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "build_demo_class.py"
spec = importlib.util.spec_from_file_location("build_demo_class", SCRIPT)
builder = importlib.util.module_from_spec(spec)
sys.modules["build_demo_class"] = builder  # dataclasses resolve annotations via sys.modules
spec.loader.exec_module(builder)


def test_invented_names_are_unique_and_deterministic():
    a = builder.invented_names(40, random.Random(7))
    b = builder.invented_names(40, random.Random(7))
    assert a == b
    assert len(set(a)) == 40


def test_exclusions_resolve_elop_ids_to_identities_and_persist(tmp_path):
    exclude = tmp_path / "exclude.txt"
    exclude.write_text("3002  # looked familiar\nSome_Person\n\n")
    previous = [{"elop_id": "3002", "lfw_identity": "Famous_Person"}]

    assert builder.resolve_exclusions(exclude, previous) == {"Famous_Person", "Some_Person"}
    # rewritten with identities so a rebuild (new IDs) keeps them excluded
    assert builder.resolve_exclusions(exclude, []) == {"Famous_Person", "Some_Person"}


def test_missing_exclude_file_means_no_exclusions(tmp_path):
    assert builder.resolve_exclusions(tmp_path / "nope.txt", []) == set()


def test_seed_sql_escapes_quotes_and_uses_photo_urls(tmp_path):
    seed = tmp_path / "seed.sql"
    roster = [
        builder.RosterEntry("3001", "Rosa", "O'Brien", "3", ["ELOP", "ASES"], "lfw", "X"),
        builder.RosterEntry("3002", "Theo", "Tran", "K", ["ELOP"], "developer"),
    ]
    builder.write_seed(roster, seed)
    sql = seed.read_text()
    assert "TRUNCATE public.students CASCADE;" in sql
    assert "'O''Brien'" in sql
    assert "'A3001'" in sql and "NULL" in sql  # ASES id only for ASES students
    assert "ARRAY['ELOP', 'ASES']::text[]" in sql
    assert "http://localhost:8000/api/v1/students/3002/photo" in sql
    assert "X" not in sql.split("VALUES", 1)[1]  # the real LFW identity never reaches the database


def test_thumbnail_is_square_even_at_image_edges():
    image = np.random.default_rng(0).integers(0, 255, (300, 200, 3), dtype=np.uint8)
    face = DetectedFace(x=150, y=10, width=80, height=90, score=0.99, raw=np.zeros(15, np.float32))
    assert builder.thumbnail(image, face).shape == (256, 256, 3)


def test_developers_file_is_validated(tmp_path):
    path = tmp_path / "developers.json"
    path.write_text(json.dumps([{"slug": "owner", "first_name": "A", "last_name": "B", "grade": "12"}]))
    with pytest.raises(SystemExit):
        builder.load_developers(path)
    path.write_text(json.dumps([{"slug": "owner", "first_name": "A", "last_name": "B", "grade": "5"}]))
    assert builder.load_developers(path)[0]["slug"] == "owner"
    assert builder.load_developers(tmp_path / "missing.json") == []

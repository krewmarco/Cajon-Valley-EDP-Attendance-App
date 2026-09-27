"""Enrolled-embedding store: one NumPy matrix + JSON metadata.

The on-disk files are biometric data. They live in the git-ignored index/
folder and are deleted per label on request."""
from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

EMBEDDINGS_FILE = "embeddings.npy"
META_FILE = "meta.json"


@dataclass(frozen=True)
class Match:
    label: str
    score: float  # best cosine similarity across the label's embeddings


class IndexModelMismatch(RuntimeError):
    pass


class EmbeddingIndex:
    def __init__(self, model_name: str, directory: Path | None = None):
        """directory=None keeps everything in memory (evaluation, tests)."""
        self.model_name = model_name
        self.directory = directory
        self._lock = threading.Lock()
        self._vectors = np.zeros((0, 0), dtype=np.float32)
        self._labels: list[str] = []
        self._sources: list[str] = []
        if directory is not None:
            self._load()

    # ── queries ──────────────────────────────────────────────────────────
    @property
    def count(self) -> int:
        return len(self._labels)

    def labels(self) -> list[str]:
        return sorted(set(self._labels))

    def search(self, vector: np.ndarray, k: int = 3) -> list[Match]:
        with self._lock:
            if not self._labels:
                return []
            scores = self._vectors @ vector.astype(np.float32)
            best: dict[str, float] = {}
            for label, score in zip(self._labels, scores):
                if score > best.get(label, -2.0):
                    best[label] = float(score)
        ranked = sorted(best.items(), key=lambda item: item[1], reverse=True)
        return [Match(label, score) for label, score in ranked[:k]]

    # ── mutations ────────────────────────────────────────────────────────
    def add(self, label: str, vector: np.ndarray, source: str) -> None:
        vector = vector.astype(np.float32).reshape(1, -1)
        with self._lock:
            if self._vectors.size == 0:
                self._vectors = vector
            else:
                if vector.shape[1] != self._vectors.shape[1]:
                    raise ValueError("Embedding dimension does not match the index")
                self._vectors = np.vstack([self._vectors, vector])
            self._labels.append(label)
            self._sources.append(source)
            self._save()

    def remove(self, label: str) -> int:
        with self._lock:
            keep = [i for i, existing in enumerate(self._labels) if existing != label]
            removed = len(self._labels) - len(keep)
            if removed:
                self._vectors = self._vectors[keep] if keep else np.zeros((0, 0), dtype=np.float32)
                self._labels = [self._labels[i] for i in keep]
                self._sources = [self._sources[i] for i in keep]
                self._save()
        return removed

    # ── persistence ──────────────────────────────────────────────────────
    def _load(self) -> None:
        meta_path = self.directory / META_FILE
        if not meta_path.exists():
            return
        meta = json.loads(meta_path.read_text())
        if meta["model_name"] != self.model_name:
            raise IndexModelMismatch(
                f"Index was built with {meta['model_name']}, not {self.model_name}; re-enroll"
            )
        self._labels = meta["labels"]
        self._sources = meta["sources"]
        self._vectors = np.load(self.directory / EMBEDDINGS_FILE) if self._labels else np.zeros((0, 0), dtype=np.float32)

    def _save(self) -> None:
        if self.directory is None:
            return
        self.directory.mkdir(parents=True, exist_ok=True)
        meta = {"model_name": self.model_name, "labels": self._labels, "sources": self._sources}
        # Write to temp files, then rename, so a crash never leaves a half-written index
        tmp_vectors = self.directory / (EMBEDDINGS_FILE + ".tmp")
        with open(tmp_vectors, "wb") as fh:
            np.save(fh, self._vectors)
        tmp_meta = self.directory / (META_FILE + ".tmp")
        tmp_meta.write_text(json.dumps(meta))
        os.replace(tmp_vectors, self.directory / EMBEDDINGS_FILE)
        os.replace(tmp_meta, self.directory / META_FILE)

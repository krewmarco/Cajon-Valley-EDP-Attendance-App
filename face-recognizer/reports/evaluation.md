# Face Recognizer Prototype — Evaluation

_Generated 2026-09-27 08:40 by `scripts/evaluate.py` (seed 0). Aggregate numbers only; no images, embeddings, or file names._

**Model:** OpenCV YuNet (detection) + SFace (embedding), CPU.
**Subject:** one adult (the project owner, with consent) versus LFW photos of other people.

## Data

| | Count |
|---|---|
| Owner photos provided | 12 |
| Enrolled (passed quality gates) | 7 |
| Enrollment rejections | 0 |
| Held-out owner photos (genuine) | 5 (0 with no face detected) |
| Impostor photos (LFW, one per identity) | 500 (1 with no face detected) |

## Scores (cosine similarity to the owner's closest enrolled photo)

- **Genuine** (owner, held-out): min 0.733 · mean 0.759 · max 0.832
- **Impostor** (other people): min -0.074 · mean 0.162 · max 0.383 · 99th percentile 0.340

## Threshold table

| Threshold | Owner recognized (genuine accept) | Impostor falsely matched (false accept) | False accepts |
|---|---|---|---|
| 0.30 | 100.0% | 2.6% | 13 |
| 0.35 | 100.0% | 1.0% | 5 |
| 0.40 | 100.0% | 0.0% | 0 |
| 0.45 | 100.0% | 0.0% | 0 |
| 0.50 | 100.0% | 0.0% | 0 |
| 0.55 | 100.0% | 0.0% | 0 |
| 0.60 | 100.0% | 0.0% | 0 |

## Recommendation

**0.40** is the lowest threshold with **no** false accepts among 499 impostors, while accepting 100% of held-out owner photos. Zero observed false accepts is not a zero rate: with 499 impostors, the 95% upper bound is about 0.6% (rule of three).

For the human-in-the-loop design, a false accept means a wrong candidate is *suggested* to the attendant, not an automatic check-in. The HIGH/MODERATE badge thresholds should sit at or above this value.

Median detect + embed time: **10 ms** per photo on this machine's CPU.

## Limitations

- **One adult subject.** Children's faces behave differently and change over a school year; this says nothing about accuracy on students.
- **Still photos** taken by the owner, not live frames at a check-in podium (motion, lighting, angles).
- **LFW** is mostly adult public figures, and its demographics skew toward white men; the impostor scores may not represent a school population.
- 500 impostors bounds the false-accept rate only coarsely (see the rule-of-three note above).
- A threshold chosen on this data should be re-measured on the target population before any real use.

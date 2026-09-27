# Face Check-In Demo — Runbook

Shows the full flow: **camera → top-3 face candidates → attendant confirms → check-in recorded → scanner dongle types the student's ID**, with a fake classroom of adults. Background: [`plans/demo_face_checkin_plan.md`](../plans/demo_face_checkin_plan.md).

> **No student data.** The "students" are 30 people from the public LFW dataset (each with only one photo there), shown under invented names, plus the developers, who have consented. Everything runs on this laptop, on `localhost`.

## Requirements

- Apple Silicon Mac, **M1 or newer, 16 GB RAM**. See [Measured on the minimum device](#measured-on-the-minimum-device).
- Docker Desktop (about 6–8 GB memory allocated), Supabase CLI (`brew install supabase/tap/supabase`), Node 20+, Python 3.11 via `uv`.
- Chrome or Safari with camera access for `http://localhost:3000`.

## One-time setup

1. **Dependencies:** run `npm ci`, then `npm ci` in `scanner/manager` and in `scanner/emulator`, then do the face service setup in [`face-recognizer/README.md`](../face-recognizer/README.md#setup) (models + LFW).
2. **Scanner tokens:** `cp scanner/.env.example scanner/.env`, then set real tokens.
3. **Developers:**
   - Put 10–20 varied photos of each developer in `face-recognizer/data/developers/<slug>/`. HEIC is fine; use one face per photo.
   - `cp face-recognizer/demo.developers.example.json face-recognizer/demo/developers.json`, then set each developer's display name and grade.
4. **Build the classroom:** `(cd face-recognizer && .venv/bin/python scripts/build_demo_class.py)`.
   - Look through `face-recognizer/demo/photos/`. If a face is recognizable (a public figure), add its ELOP ID to `face-recognizer/demo/exclude.txt` and rebuild.
5. **Start the backend:** `scripts/demo/start.sh`. The first run downloads the Supabase images (a few minutes), creates the demo staff logins, and generates their password into `.env.demo.local`.
6. **Start the app:** `npm run dev`, open http://localhost:3000, and log in as `thomasv@cajonvalley.net` with the password from `.env.demo.local`.
7. **Configure the scanner:** open the **Scanner** pill in the header as Lead. The manager URL, token and station are pre-filled from `.env.local`; check them and click **Save Settings**, and the pill should turn green.

All generated data is git-ignored: developer photos, `demo/`, `index/`, `.env.local`, `.env.demo.local`, `supabase/seed.demo.sql`, and `logs/`. **Never commit it; the repo is public.**

## Running the demo

| Screen | Where |
|---|---|
| Attendance app | http://localhost:3000 |
| Scanner emulator ("what the SIS sees") | http://localhost:8080 (paste `SCANNER_AUTH_TOKEN` from `scanner/.env`) |
| Database (optional) | Supabase Studio at http://127.0.0.1:54323 |

**Script:**
1. Show the roster: 31 "students", all absent.
2. Open **Face Check-In** (the face icon in the header). The screen is labeled *Demo classroom: adult volunteers and public photos*.
3. A developer steps in front of the camera, and the top 3 appear:
   - the developer as **HIGH** (green)
   - two lookalikes as **LOW** (grey), shown but not confirmable
4. Point out the human in the loop: nothing happens until the attendant taps **Confirm & Check-In**.
5. Tap it. You'll see:
   - a success banner, with the student shown as checked in on the roster
   - the **emulator page** showing the ELOP ID "typed" into the SIS
   - the Scanner pill staying green
6. Show the **LOW** case: someone not in the class, or a photo on a phone. The screen says *No confident match*, and manual search is the path forward.
7. Optionally, show the audit trail in `logs/dev-audit.jsonl`: a `CHECK_IN` event with `verification_method: FACE_CONFIRMED` and the confidence score.

**Between runs:** `scripts/demo/reset.sh` (everyone absent; dev logs and emulator history cleared), then reload the app.

**Dev tricks:**
- `http://localhost:3000/?camera=off` turns off the camera.
- **Use test photo (dev)** under the camera view recognizes a still image instead. Useful for rehearsing without a person.

## Stop and delete demo data

```bash
scripts/demo/stop.sh                                   # stop face service, scanner stack, Supabase
(cd face-recognizer && rm -rf index demo data/developers)   # remove embeddings, thumbnails, roster, developer photos
supabase stop --no-backup                              # drop the local database volume
rm -f .env.local .env.demo.local supabase/seed.demo.sql logs/*.jsonl
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| No face icon in the header | `VITE_FACE_API_URL` is missing from `.env.local`; rerun `start.sh` or add it, then restart `npm run dev` |
| Roster empty after login | You logged in with a quick demo account (no Supabase session); use email + password instead |
| "Face service unreachable" | Check `curl localhost:8000/api/v1/health` and `logs/face-service.log` |
| Scanner pill grey/offline | `docker ps` should show the `edp-dongle-manager` / emulator containers healthy; rerun `start.sh` |
| Candidate photos broken | The face service must run with `DEMO_GALLERY=1` (`start.sh` does this) |

## Measured on the minimum device

Reference laptop: **Apple M1, 16 GB, macOS 15.7**, Docker Desktop with about 8 GB allocated. Measured 2026-09-27 with the full backend running: local Supabase (trimmed to 7 services), scanner emulators and dongle manager, the face service, and the Vite dev server.

| | Measured |
|---|---|
| Demo containers (Supabase + scanner stack) | 886 MiB |
| Face service (Python, models loaded) | 241 MiB |
| macOS memory free | 51%, no swap in use |
| `/recognize` on a 960×540 frame (50 runs) | 14 ms median, 19 ms p95 on the server; about 15 ms round trip |
| Frame interval in Face Check-In | 600 ms, so recognition uses about 3% of the budget |
| Earlier live-camera session, with Chrome running | about 36 ms per frame on the server |
| `start.sh` with images cached | about 21 s |

Chrome's own memory wasn't included in this measurement. The free-memory margin leaves ample room for it.

**Conclusion:** an M1 with 16 GB runs the whole demo comfortably. Memory, not CPU, is the constraint, which is why Supabase is trimmed in `supabase/config.toml`. Any newer Apple Silicon Mac has more headroom.

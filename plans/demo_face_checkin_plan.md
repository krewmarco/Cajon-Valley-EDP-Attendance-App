# Demo: Face Check-In with a Fake Adult Classroom

## Context

For the district demo we want to show the full flow: **camera → top-3 face candidates → attendant confirms → check-in recorded → scanner dongle types the ID**. We want to do this **without any student biometrics**, which schools won't want to take on.

The "classroom" is:
- **~30 fake students,** each shown with one photo of a real but mostly non-famous person from LFW: people with only one photo in the dataset. Synthetic faces were considered; they're easy to use, but getting a clean license takes time. The photo source is a swappable folder plus a roster file, so moving to synthetic later only means dropping in a new folder.
- **Two developers:** the project owner and one other developer. Both consent, and their photos stay local only.

Only the developers are ever in front of the camera. The fake students serve as the lineup the developers are matched against, and they fill candidate slots 2–3 with low scores, which shows why a human confirms.

**Runs on:** any **Apple Silicon Mac, M1 or newer, with 16 GB RAM**, all on `localhost`. The camera works without HTTPS on localhost. Scanner = Docker emulator. Database = **local Supabase**.
- **The reference machine is the development laptop** (M1, 16 GB, macOS 15.7). If the demo runs well there, it runs well on anything newer.
- The face service already measured about 10 ms per frame on this M1.
- **Memory is the constraint,** not CPU. Local Supabase, the scanner stack, the face service, Vite and Chrome all run together, so Supabase is trimmed to the services the demo needs (step 1), and Docker Desktop is given about 6 GB.

**Builds on:**
- #1: scanner dongle client and check-in hook
- #2: audit log
- #4: scanner dev log
- #5: dev-only demo login
- `feat/face-recognizer-prototype`: the face service, with a measured match threshold of 0.40

## Findings that shape the plan

- **The check-in flow is the other way around.** Today, `ConfirmationModal` (`src/components/ConfirmationModal.tsx`) picks the student first and then *pretends* to verify them (`MockDatabase` / `PasskeyService` in `src/utils/mock.ts`, with a random match score). The demo needs **camera first, then find the student** (top 3), so it's a **new screen**. We reuse `handleCheckIn(studentId)` in `src/App.tsx`, which already writes to Supabase, logs the audit `CHECK_IN` and triggers the scanner via `injectStudentBarcode`.
- **Schema drift:** `supabase/schema.sql` lacks columns the app uses. `mapDbToStudent` in `src/supabaseClient.ts` and `App.tsx` read and write `sunrise_status`, `sunrise_checkin_time`, `sunrise_staff`, `sunrise_checkout_time`, the matching `sunset_*` columns, `checkin_photo`, `sms_sent_time`, `last_checkout_by`, and the `behavior*` and `head_injury*` columns. It also has `parent_name NOT NULL`, which the app never sets. The production schema is unknown, so this plan only changes **local** migrations. Follow-up: get the real production schema.
- **Security rules:** reading `students` requires a logged-in Supabase user, and the quick demo accounts (#5) skip Supabase login. For the demo, we seed **real local accounts** with the same emails as `INITIAL_STAFF` (`src/utils/mockData.ts`), so the normal email and password login in `StaffLogin.tsx` works and the security rules stay realistic.
- **Photos in the database:** `handleCheckIn` stores the camera photo in `students.checkin_photo`. The face check-in path must **not** pass a frame, so no biometric image is stored (spec §4.1).

## Branch & workspace

- New branch `feat/demo-face-checkin`: start from `feat/scanner-dev-log` (which contains #1, #2 and #4), then merge in `fix/dev-only-demo-login` (#5) and `feat/face-recognizer-prototype`. Resolve conflicts and run all test suites before adding new work.
- The demo runs from a separate worktree, `../edp-demo`, so the user's main folder stays untouched.
- On the fork, open a **draft PR** that lists its dependencies.

## Steps

### 0. Save the plan
Commit this plan as `plans/demo_face_checkin_plan.md` on the new branch.

### 1. Local Supabase (`supabase/`)
- Install the CLI (`brew install supabase/tap/supabase`) and run `supabase init`. This needs Docker running; it isn't running right now.
- To fit a 16 GB M1, `supabase/config.toml` keeps only database, auth, REST, realtime, Kong and Studio. It **turns off** analytics/logging, storage, image processing, edge functions and the email test inbox, since the demo uses none of them.
- Migrations:
  - `…_base.sql`: the current `schema.sql`.
  - `…_align_students_with_app.sql`: add the missing `students` columns and relax `parent_name`.
  - `…_realtime.sql`: add `students` to Supabase's realtime publication, so the app's live updates work.
- `scripts/demo/setup_supabase.mjs`: using the local service key from `supabase status`, it creates the demo **auth users** and **staff rows** matching `INITIAL_STAFF`. Passwords come from `.env.demo`, which is git-ignored and never committed.
- The app's local `.env.local` (already git-ignored by `*.local`) gets:
  - `VITE_SUPABASE_URL=http://127.0.0.1:54321` and the local anon key
  - `VITE_FACE_API_URL=http://localhost:8000`

### 2. Demo classroom builder (`face-recognizer/scripts/build_demo_class.py`)
- **Inputs:**
  - LFW (already downloaded)
  - `data/developers/<slug>/` photo folders, one per developer
  - `demo/developers.json`, git-ignored: each developer's display name, grade, and which photo to use as their yearbook photo
- **Fake students:** pick N (default 30) LFW identities that have **exactly one photo** and pass the quality gates after 2× upscale, using a fixed seed. Honor an `--exclude` list, so any recognizable face can be dropped by re-running.
- **Fake names and IDs:** assign invented names (not LFW's real names), grades TK–5, ELOP/ASES programs, and ELOP IDs `3001…`. Developers get IDs from the same range.
- **Outputs,** all git-ignored and local only:
  - `face-recognizer/demo/photos/<elop_id>.jpg`: 256 px face-centered yearbook thumbnails
  - `face-recognizer/demo/roster.json`
  - `supabase/seed.demo.sql`: students table rows, with `yearbook_photo_url` = `http://localhost:8000/api/v1/students/<elop_id>/photo`
  - Enrollment into the face service index, **label = ELOP ID**. It first removes any labels from the previous demo, so rebuilds are clean.
- Reuse `app/images.decode_image`, `app/quality.check_enrollment_quality`, `EmbeddingIndex` and the `evaluate.py` LFW helpers.

### 3. Face service additions (`face-recognizer/app/main.py`)
- `DEMO_GALLERY=1` turns on `GET /api/v1/students/{id}/photo`, which serves the demo thumbnail and rejects any ID that isn't a plain ELOP ID. It's off by default.
- CORS: allow only `ALLOWED_ORIGINS` (default `http://localhost:3000`). Bind to `127.0.0.1`.
- `/recognize` stays as is. Candidates carry `label` = ELOP ID; the app maps it to names.
- Tests: the photo endpoint is off by default, ID validation, CORS.

### 4. React face check-in
- **`src/services/faceRecognitionService.ts`,** following the pattern of `scannerDongleService.ts`:
  - `recognizeFrame(blob)` never throws, times out after 3 s, and returns `{ faceDetected, box, candidates: [{ elopId, score, level }] }`.
  - The face service URL comes from `VITE_FACE_API_URL`; the feature is hidden when that isn't set.
  - Vitest tests with a mocked `fetch`.
- **`src/components/FaceCheckIn.tsx`,** using inline styles and the app's CSS variables:
  - Camera on the left, sending a frame about every 600 ms.
  - Top-3 candidate cards on the right, looked up in the `students` list by `elopId`: yearbook photo, name, grade, score badge, and **Confirm & Check-In**.
  - Students already checked in are shown as such, with Confirm disabled.
  - Recognition pauses briefly after each confirm, with a success message.
  - A manual search box as the fallback.
  - **Dev only (`import.meta.env.DEV`):** a "Use test photo" file picker, so the flow can be tested and demoed without the camera.
- **Opened from** a header camera button in `App.tsx`. Confirm calls `handleCheckIn(studentId)` **without a photo**. Because of that, the check-in writes to Supabase, logs the audit event and triggers the scanner on its own.
- **Audit:** the `CHECK_IN` event from `gdLogCheckIn` in `src/services/googleDriveService.ts` gets optional `verification_method` (`FACE_CONFIRMED` / `MANUAL`) and `confidence_score` fields. The Apps Script ignores fields it doesn't know.

### 5. Demo scripts and runbook
- `scripts/demo/start.sh`: check Docker; then start local Supabase with the migrations and seed, the scanner emulator stack (`scanner/docker-compose.yml`) and the face service (with `DEMO_GALLERY=1`); then print the app URL.
- `scripts/demo/reset.sh`: set every student back to `absent`, and clear the dev audit and scanner logs.
- `docs/demo-runbook.md`, covering:
  - one-time setup: developer photos, `developers.json`, `.env.demo`, `.env.local`, dongle settings in the app's Scanner modal
  - the demo script: log in, open Face Check-In, a developer steps up, top 3 shown, Confirm, the emulator page shows the ID typed
  - teardown and data deletion

## Privacy guardrails
- No student data. Developer photos, embeddings and thumbnails stay in git-ignored folders.
- Before each commit: `git status` plus the same "no images, embeddings or weights" history check used on the face branch.
- The assistant never opens developer photos, and never screenshots a live camera. Browser checks use LFW test photos through the dev "Use test photo" picker.
- The screen is labeled **"Demo classroom: adult volunteers and public photos."** Nobody's real LFW name is ever shown.

## Verification
1. **All suites:** app Vitest, the scanner manager and emulator `npm test`, and face-recognizer `pytest`. All pass after the merge and after each step.
2. **`start.sh` from clean:** Supabase, the emulator, the manager and the face service are all healthy, and the app loads the ~32-student roster from local Supabase after email login.
3. **In the browser:**
   - Open Face Check-In and use "Use test photo" with a **different** LFW photo of a roster student where one exists; otherwise use the enrolled photo as a sanity check. That student should be top 1.
   - Confirm, then check that the student shows as checked in, the database row is updated, `dev-audit.jsonl` has `CHECK_IN` with `verification_method=FACE_CONFIRMED`, and `dev-scanner.jsonl` has a `SCAN` whose request ID matches the emulator's history.
4. **Live with the camera (run by the owner):** the owner is top 1 with HIGH confidence. `reset.sh` restores a clean state.
5. **Minimum-device check on this M1 (16 GB):**
   - With everything running (Supabase, scanner stack, face service, Vite, Chrome on Face Check-In), record Docker memory (`docker stats --no-stream`), overall memory pressure, and the face service's `/recognize` time.
   - Target: recognition stays well under the ~600 ms frame interval, and there's no memory-pressure warning.
   - The results go into `docs/demo-runbook.md` as the stated minimum requirement.

## Open items (not blocking)
- The other developer's consent and photos.
- Look through the generated roster thumbnails once, and exclude any recognizable face.
- Get the production Supabase schema so the local migrations can be reconciled with it.

#!/usr/bin/env bash
# Start everything the face check-in demo needs (see docs/demo-runbook.md).
# Resets the demo database to a clean state each time.
set -euo pipefail
cd "$(dirname "$0")/../.."

fail() { echo "✗ $*" >&2; exit 1; }

docker info >/dev/null 2>&1 || fail "Docker is not running — start Docker Desktop first"
command -v supabase >/dev/null || fail "Supabase CLI missing — brew install supabase/tap/supabase"
[ -x face-recognizer/.venv/bin/python ] || fail "Face service not set up — see face-recognizer/README.md (Setup)"
[ -f face-recognizer/demo/roster.json ] || fail "Classroom not built — (cd face-recognizer && .venv/bin/python scripts/build_demo_class.py)"
[ -f scanner/.env ] || fail "scanner/.env missing — cp scanner/.env.example scanner/.env and set real tokens"

echo "→ Local Supabase (clean demo roster)"
supabase start >/dev/null
supabase db reset >/dev/null          # re-applies migrations + supabase/seed.demo.sql
node scripts/demo/setup_supabase.mjs

echo "→ Scanner emulator + dongle manager"
(cd scanner && docker compose up -d --build --wait >/dev/null)

echo "→ Face service (demo gallery on, localhost only)"
# Stop a previous instance and wait until it has actually released the port;
# otherwise the health check below can hit the old server while it shuts down.
pkill -f "uvicorn app.main:app" 2>/dev/null || true
for _ in $(seq 1 40); do lsof -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.25; done
lsof -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1 && fail "Port 8000 is in use by another program"
mkdir -p logs
# exec replaces the subshell, and its output goes to the log, so no process keeps
# this script's stdout open (a lingering subshell made `start.sh | …` hang).
(cd face-recognizer && DEMO_GALLERY=1 exec nohup .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000) \
  > logs/face-service.log 2>&1 < /dev/null &
for _ in $(seq 1 60); do curl -sf localhost:8000/api/v1/health >/dev/null && break; sleep 0.5; done
curl -sf localhost:8000/api/v1/health >/dev/null || fail "Face service did not start — see logs/face-service.log"

if [ ! -f .env.local ]; then
  echo "→ Writing .env.local (git-ignored)"
  anon=$(supabase status -o env 2>/dev/null | sed -n 's/^ANON_KEY="\(.*\)"$/\1/p')
  token=$(sed -n 's/^MANAGER_CLIENT_TOKEN=//p' scanner/.env)
  umask 077
  cat > .env.local <<ENV
# Local demo settings (git-ignored via *.local). See docs/demo-runbook.md.
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=$anon
VITE_FACE_API_URL=http://localhost:8000
VITE_SCANNER_MANAGER_URL=http://localhost:5050
VITE_SCANNER_STATION_ID=station-alpha-1
VITE_SCANNER_MANAGER_TOKEN=$token
ENV
fi

students=$(curl -sf localhost:8000/api/v1/health | sed -n 's/.*"enrolled_labels":\([0-9]*\).*/\1/p')
cat <<MSG

✓ Demo backend ready ($students students enrolled)
  App:              npm run dev   → http://localhost:3000
  Login:            thomasv@cajonvalley.net  (password in .env.demo.local)
  Scanner screen:   http://localhost:8080   (paste SCANNER_AUTH_TOKEN from scanner/.env)
  Supabase Studio:  http://127.0.0.1:54323
  Between runs:     scripts/demo/reset.sh      When done: scripts/demo/stop.sh
MSG

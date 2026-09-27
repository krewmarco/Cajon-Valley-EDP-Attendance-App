#!/usr/bin/env bash
# Stop the demo backend. Data (roster, enrolled faces) stays until deleted —
# see docs/demo-runbook.md "Delete demo data".
set -euo pipefail
cd "$(dirname "$0")/../.."
pkill -f "uvicorn app.main:app" 2>/dev/null || true
(cd scanner && docker compose stop >/dev/null) || true
supabase stop >/dev/null || true
echo "✓ Face service, scanner stack, and local Supabase stopped."

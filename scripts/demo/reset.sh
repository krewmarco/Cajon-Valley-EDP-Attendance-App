#!/usr/bin/env bash
# Put the demo back to "nobody checked in" without restarting anything.
set -euo pipefail
cd "$(dirname "$0")/../.."
docker exec supabase_db_edp-demo psql -U postgres -q -c "
  UPDATE public.students SET
    sunrise_status = 'absent', sunset_status = 'absent',
    sunrise_checkin_time = NULL, sunset_checkin_time = NULL,
    sunrise_checkout_time = NULL, sunset_checkout_time = NULL,
    sunrise_staff = NULL, sunset_staff = NULL,
    last_checkout_by = NULL, sms_sent_time = NULL, checkin_photo = NULL;"
rm -f logs/dev-audit.jsonl logs/dev-scanner.jsonl
(cd scanner && docker compose restart scanner-emulator-1 scanner-emulator-2 >/dev/null)   # clears the emulators' scan history
echo "✓ All students absent; dev logs and emulator history cleared. Reload the app."

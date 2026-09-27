-- Align public.students with the columns the app actually reads/writes
-- (mapDbToStudent in src/supabaseClient.ts; handleCheckIn / handleCheckOut /
-- handleSaveStudent in src/App.tsx). supabase/schema.sql predates these; the
-- production schema should be reconciled with this migration.
ALTER TABLE public.students
  ALTER COLUMN parent_name DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS sunrise_status text NOT NULL DEFAULT 'absent'
    CHECK (sunrise_status IN ('absent', 'present', 'checked_out', 'pending_parent')),
  ADD COLUMN IF NOT EXISTS sunset_status text NOT NULL DEFAULT 'absent'
    CHECK (sunset_status IN ('absent', 'present', 'checked_out', 'pending_parent')),
  -- Times are the display strings the app writes (e.g. '7:02 PM')
  ADD COLUMN IF NOT EXISTS sunrise_checkin_time text,
  ADD COLUMN IF NOT EXISTS sunset_checkin_time text,
  ADD COLUMN IF NOT EXISTS sunrise_checkout_time text,
  ADD COLUMN IF NOT EXISTS sunset_checkout_time text,
  ADD COLUMN IF NOT EXISTS sunrise_staff text,
  ADD COLUMN IF NOT EXISTS sunset_staff text,
  ADD COLUMN IF NOT EXISTS last_checkout_by text,
  ADD COLUMN IF NOT EXISTS sms_sent_time text,
  -- Photo captured by the legacy check-in modal; the face check-in never sets it
  ADD COLUMN IF NOT EXISTS checkin_photo text,
  ADD COLUMN IF NOT EXISTS behavior text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS behavior_issues text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS behavior_timestamp text,
  ADD COLUMN IF NOT EXISTS behavior_staff text,
  ADD COLUMN IF NOT EXISTS behavior_description text,
  ADD COLUMN IF NOT EXISTS head_injury boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS head_injury_logs jsonb NOT NULL DEFAULT '[]'::jsonb;

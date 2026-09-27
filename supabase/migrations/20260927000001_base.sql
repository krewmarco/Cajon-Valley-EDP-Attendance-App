-- Base schema: verbatim copy of supabase/schema.sql (see that file for docs).
-- ============================================================================
-- EDP Attendance App — Supabase Database Schema + Hardened RLS Policies
-- ============================================================================
-- Apply to your Supabase project via:
--   1. supabase.com Dashboard → SQL Editor → New query → paste and run, OR
--   2. supabase db push (if using local Supabase CLI)
-- ============================================================================
-- ── Tables ────────────────────────────────────────────────────────────────────
-- Staff table — EDP staff members
CREATE TABLE IF NOT EXISTS public.staff (
  id uuid PRIMARY KEY,
  -- matches auth.users.id (Supabase Auth)
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('Lead', 'Assistant', 'Coach')),
  organization text DEFAULT 'EDP',
  email text UNIQUE,
  phone text,
  assigned_grades text [] DEFAULT '{}',
  can_check_in boolean DEFAULT true,
  can_admin_tasks boolean DEFAULT false,
  can_check_out boolean DEFAULT true,
  can_hir boolean DEFAULT true,
  can_we_care boolean DEFAULT true,
  has_passkey boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL
);
-- Students table — EDP student roster
CREATE TABLE IF NOT EXISTS public.students (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  first_name text NOT NULL,
  last_name text NOT NULL,
  grade text NOT NULL,
  parent_name text NOT NULL,
  parent_phone text,
  parent_email text,
  elop_id text NOT NULL UNIQUE,
  ases_id text,
  programs text [] NOT NULL DEFAULT '{}',
  has_snack boolean DEFAULT false,
  is_checkin_blocked boolean DEFAULT false,
  yearbook_photo_url text,
  -- URL only, never raw image data in DB
  guardians jsonb DEFAULT '[]'::jsonb,
  -- Guardian contact array
  created_at timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL
);
-- Daily attendance table
CREATE TABLE IF NOT EXISTS public.daily_attendance (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id uuid REFERENCES public.students(id) ON DELETE CASCADE NOT NULL,
  date date NOT NULL DEFAULT current_date,
  program text NOT NULL CHECK (program IN ('sunrise', 'sunset')),
  status text NOT NULL CHECK (
    status IN (
      'absent',
      'present',
      'checked_out',
      'pending_parent'
    )
  ),
  check_in_time time,
  check_out_time time,
  staff_id uuid REFERENCES public.staff(id),
  attendance_code text,
  pickup_name text,
  created_at timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL,
  UNIQUE (student_id, date, program)
);
-- Behavior logs table
CREATE TABLE IF NOT EXISTS public.behavior_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id uuid REFERENCES public.students(id) ON DELETE CASCADE NOT NULL,
  level text NOT NULL CHECK (level IN ('green', 'yellow', 'red')),
  issues text [] DEFAULT '{}',
  description text,
  actions text,
  staff_id uuid REFERENCES public.staff(id),
  submitted_at timestamp with time zone,
  edit_count integer DEFAULT 0,
  last_edited_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL
);
-- Head injury logs table
CREATE TABLE IF NOT EXISTS public.head_injury_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id uuid REFERENCES public.students(id) ON DELETE CASCADE NOT NULL,
  stage text NOT NULL CHECK (stage IN ('0min', '15min', '30min')),
  symptoms jsonb DEFAULT '{}'::jsonb,
  notes text,
  staff_id uuid REFERENCES public.staff(id),
  created_at timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL
);
-- ── Enable Row Level Security ─────────────────────────────────────────────────
-- RLS ensures that even if the anon key is exposed, unauthenticated requests
-- cannot read or write student PII.
ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.behavior_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.head_injury_logs ENABLE ROW LEVEL SECURITY;
-- ── RLS Policies: staff table ─────────────────────────────────────────────────
-- Authenticated users can read all staff records (needed to populate dropdowns).
-- Only a Lead (admin) can insert/update/delete staff. Enforce this via a
-- custom claim or a join to the staff table itself.
CREATE POLICY "staff: authenticated users can read" ON public.staff FOR
SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "staff: only leads can insert" ON public.staff FOR
INSERT WITH CHECK (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1
      FROM public.staff s
      WHERE s.id = auth.uid()
        AND s.role = 'Lead'
    )
  );
CREATE POLICY "staff: only leads can update" ON public.staff FOR
UPDATE USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1
      FROM public.staff s
      WHERE s.id = auth.uid()
        AND s.role = 'Lead'
    )
  );
CREATE POLICY "staff: only leads can delete" ON public.staff FOR DELETE USING (
  auth.role() = 'authenticated'
  AND EXISTS (
    SELECT 1
    FROM public.staff s
    WHERE s.id = auth.uid()
      AND s.role = 'Lead'
  )
);
-- ── RLS Policies: students table ──────────────────────────────────────────────
-- All authenticated staff can read students.
-- Only authenticated staff can insert/update. Deletes require Lead role.
-- Anon (unauthenticated) requests → blocked.
CREATE POLICY "students: authenticated staff can read" ON public.students FOR
SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "students: authenticated staff can insert" ON public.students FOR
INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "students: authenticated staff can update" ON public.students FOR
UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "students: only leads can delete" ON public.students FOR DELETE USING (
  auth.role() = 'authenticated'
  AND EXISTS (
    SELECT 1
    FROM public.staff s
    WHERE s.id = auth.uid()
      AND s.role = 'Lead'
  )
);
-- ── RLS Policies: daily_attendance ────────────────────────────────────────────
CREATE POLICY "attendance: authenticated staff can read" ON public.daily_attendance FOR
SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "attendance: authenticated staff can insert" ON public.daily_attendance FOR
INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "attendance: authenticated staff can update" ON public.daily_attendance FOR
UPDATE USING (auth.role() = 'authenticated');
-- Attendance records should never be deleted (audit trail) — no DELETE policy.
-- ── RLS Policies: behavior_logs ───────────────────────────────────────────────
CREATE POLICY "behavior: authenticated staff can read" ON public.behavior_logs FOR
SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "behavior: authenticated staff can insert" ON public.behavior_logs FOR
INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "behavior: authenticated staff can update" ON public.behavior_logs FOR
UPDATE USING (auth.role() = 'authenticated');
-- Behavior logs are immutable after submission (edit count tracked in app layer).
-- No DELETE policy — all behavior tickets are permanent audit records.
-- ── RLS Policies: head_injury_logs ───────────────────────────────────────────
CREATE POLICY "hir: authenticated staff can read" ON public.head_injury_logs FOR
SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "hir: authenticated staff can insert" ON public.head_injury_logs FOR
INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "hir: authenticated staff can update" ON public.head_injury_logs FOR
UPDATE USING (auth.role() = 'authenticated');
-- HIR records are permanent, no DELETE policy.
-- ── Useful indexes ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON public.daily_attendance(student_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON public.daily_attendance(date);
CREATE INDEX IF NOT EXISTS idx_behavior_student ON public.behavior_logs(student_id);
CREATE INDEX IF NOT EXISTS idx_behavior_created ON public.behavior_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_hir_student ON public.head_injury_logs(student_id);
CREATE INDEX IF NOT EXISTS idx_students_elop_id ON public.students(elop_id);
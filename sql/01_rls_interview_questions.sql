-- ============================================================================
-- 01_rls_interview_questions.sql
-- Purpose: make interview_questions readable by signed-in users of the app.
--
-- WHY: probes with the anon/publishable key return HTTP 200 + zero rows, which
-- is the classic signature of "RLS enabled, no SELECT policy". The app routes
-- are all behind ProtectedRoute, so a signed-in user hits PostgREST with the
-- 'authenticated' role — that role needs an explicit SELECT policy.
--
-- This script is idempotent. Run it in the Supabase SQL Editor.
-- Review 00_introspect.sql output first — if a suitable SELECT policy already
-- exists, you do not need this.
-- ============================================================================

-- interview_questions is reference/content data (not per-user), so a signed-in
-- user may read all rows. Writes stay restricted to service_role (backend /
-- ingestion pipeline), which bypasses RLS — so no INSERT/UPDATE policy here.

ALTER TABLE public.interview_questions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "interview_questions_read_authenticated"
  ON public.interview_questions;

CREATE POLICY "interview_questions_read_authenticated"
  ON public.interview_questions
  FOR SELECT
  TO authenticated
  USING (true);

-- OPTIONAL: also allow logged-out visitors to read (only if you ever render
-- interview content on a public, non-authenticated route). Left disabled.
-- DROP POLICY IF EXISTS "interview_questions_read_anon" ON public.interview_questions;
-- CREATE POLICY "interview_questions_read_anon"
--   ON public.interview_questions FOR SELECT TO anon USING (true);

-- Sanity check after applying (run as a signed-in user via the app, or here as
-- owner just to confirm the policy compiles):
-- SELECT count(*) FROM public.interview_questions;

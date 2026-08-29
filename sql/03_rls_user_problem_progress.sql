-- ============================================================================
-- 03_rls_user_problem_progress.sql
-- Purpose: per-user row isolation on user_problem_progress (Part 4 depends on
--          reads/writes working for the signed-in user, and on NOT leaking
--          other users' progress).
--
-- Apply ONLY if 00_introspect.sql section [B] shows these policies are missing
-- or weaker than below. Idempotent. Run in the Supabase SQL Editor.
-- ============================================================================

ALTER TABLE public.user_problem_progress ENABLE ROW LEVEL SECURITY;

-- SELECT: a user sees only their own rows
DROP POLICY IF EXISTS "upp_select_own" ON public.user_problem_progress;
CREATE POLICY "upp_select_own"
  ON public.user_problem_progress
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- INSERT: a user can only create rows owned by themselves
DROP POLICY IF EXISTS "upp_insert_own" ON public.user_problem_progress;
CREATE POLICY "upp_insert_own"
  ON public.user_problem_progress
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- UPDATE: a user can only modify their own rows, and cannot reassign ownership
DROP POLICY IF EXISTS "upp_update_own" ON public.user_problem_progress;
CREATE POLICY "upp_update_own"
  ON public.user_problem_progress
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- DELETE: a user can only delete their own rows
DROP POLICY IF EXISTS "upp_delete_own" ON public.user_problem_progress;
CREATE POLICY "upp_delete_own"
  ON public.user_problem_progress
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- NOTE: useProgress.js upserts with onConflict 'user_id,problem_type,problem_id'.
-- That target needs a UNIQUE constraint to work reliably. Check 00_introspect
-- output; if missing, add:
-- DO $$
-- BEGIN
--   IF NOT EXISTS (
--     SELECT 1 FROM pg_constraint
--     WHERE conrelid = 'public.user_problem_progress'::regclass
--       AND conname  = 'uq_upp_user_type_problem'
--   ) THEN
--     ALTER TABLE public.user_problem_progress
--       ADD CONSTRAINT uq_upp_user_type_problem
--       UNIQUE (user_id, problem_type, problem_id);
--   END IF;
-- END $$;

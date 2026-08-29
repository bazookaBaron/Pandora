-- ============================================================================
-- 04_cleanup_redundant.sql
-- Removes objects that 02_indexes_constraints.sql added under new names while
-- equivalent objects already existed under Supabase's default names.
-- Safe + idempotent. Run in the Supabase SQL Editor.
-- ============================================================================

-- 1) Redundant UNIQUE constraint (keep interview_questions_subcategory_external_id_key)
ALTER TABLE public.interview_questions
  DROP CONSTRAINT IF EXISTS uq_iq_subcategory_external_id;

-- 2) Redundant answer_status index (keep the pre-existing idx_iq_status)
DROP INDEX IF EXISTS public.idx_iq_answer_status;

-- 3) RECOMMENDED (review first): collapse the overlapping progress policies.
--    The four upp_* policies are role-scoped to `authenticated` and carry proper
--    WITH CHECK clauses on INSERT/UPDATE. The older catch-all below is FOR ALL
--    TO public with no WITH CHECK — weaker and redundant. Drop it to keep one
--    clean, explicit policy set:
DROP POLICY IF EXISTS "users see own progress" ON public.user_problem_progress;

-- Verify:
-- SELECT indexname FROM pg_indexes
--   WHERE schemaname='public' AND tablename='interview_questions' ORDER BY 1;
-- SELECT policyname, cmd, roles FROM pg_policies
--   WHERE tablename='user_problem_progress' ORDER BY 1;

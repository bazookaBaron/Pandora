-- ============================================================================
-- 00_introspect.sql  —  READ-ONLY. Safe to run anytime.
-- Returns ONE row / ONE cell of pretty JSON so the Supabase SQL Editor shows
-- the whole diagnostic at once (it only renders the final statement's result).
-- Run it, click the cell, copy everything, paste it back.
-- ============================================================================

SELECT jsonb_pretty(jsonb_build_object(

  -- [A] RLS enabled / forced per table
  'rls', (
    SELECT jsonb_agg(jsonb_build_object(
      'table', c.relname, 'rls_enabled', c.relrowsecurity, 'rls_forced', c.relforcerowsecurity))
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('interview_questions','user_problem_progress',
                        'hld_questions','lld_problems','leetcode_company_problems')),

  -- [B] Policies on the two tables the app touches as a signed-in user
  'policies', (
    SELECT jsonb_agg(jsonb_build_object(
      'table', tablename, 'policy', policyname, 'roles', roles,
      'cmd', cmd, 'using', qual, 'check', with_check))
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('interview_questions','user_problem_progress')),

  -- [C] anon / authenticated grants on interview_questions
  'grants_interview_questions', (
    SELECT jsonb_agg(jsonb_build_object('grantee', grantee, 'privilege', privilege_type))
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'interview_questions'
      AND grantee IN ('anon','authenticated')),

  -- [D] TRUE row count (this query runs as owner, bypassing RLS)
  'interview_questions_total', (SELECT count(*) FROM public.interview_questions),

  -- [E] category / subcategory breakdown (what the left panel renders)
  'interview_questions_by_cat_sub', (
    SELECT jsonb_agg(x) FROM (
      SELECT category, subcategory, count(*) AS n
      FROM public.interview_questions GROUP BY 1,2 ORDER BY 1,2) x),

  -- [F] answer_status enum allowed values
  'answer_status_enum_values', (
    SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'answer_status'),

  -- [F2] answer_status live distribution
  'answer_status_distribution', (
    SELECT jsonb_agg(x) FROM (
      SELECT answer_status, count(*) AS n
      FROM public.interview_questions GROUP BY 1 ORDER BY 2 DESC) x),

  -- [G] duplicate (subcategory, external_id) pairs — MUST be [] before 02 runs
  'duplicate_subcat_externalid', (
    SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM (
      SELECT subcategory, external_id, count(*) AS copies
      FROM public.interview_questions GROUP BY 1,2 HAVING count(*) > 1) x),

  -- [H] existing UNIQUE constraints on interview_questions
  'interview_questions_unique_constraints', (
    SELECT jsonb_agg(jsonb_build_object('name', conname, 'def', pg_get_constraintdef(oid)))
    FROM pg_constraint
    WHERE conrelid = 'public.interview_questions'::regclass AND contype = 'u'),

  -- [I] existing indexes on interview_questions
  'interview_questions_indexes', (
    SELECT jsonb_agg(jsonb_build_object('name', indexname, 'def', indexdef))
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'interview_questions'),

  -- [J] CHECK + UNIQUE constraints on user_problem_progress
  'user_problem_progress_checks', (
    SELECT jsonb_agg(jsonb_build_object('name', conname, 'def', pg_get_constraintdef(oid)))
    FROM pg_constraint
    WHERE conrelid = 'public.user_problem_progress'::regclass AND contype = 'c'),
  'user_problem_progress_unique_constraints', (
    SELECT jsonb_agg(jsonb_build_object('name', conname, 'def', pg_get_constraintdef(oid)))
    FROM pg_constraint
    WHERE conrelid = 'public.user_problem_progress'::regclass AND contype = 'u')

)) AS diagnostics;

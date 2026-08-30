-- ============================================================================
-- 10_check_catalog_exposure.sql  —  READ-ONLY. Safe to run anytime.
-- Run this BEFORE and AFTER 09_lockdown_catalog_rls.sql to confirm the change.
--
--   BEFORE : leetcode_company_problems / lld_problems / hld_questions show
--            'authenticated' (and usually 'anon') under select_grantees
--            and/or rls_enabled = false  -> the browser can read them directly
--            -> the /api/catalog/* free-tier caps are bypassable.
--
--   AFTER  : rls_enabled = true AND select_grantees = (none) for those three.
--            The four "reached only after the gate / per-user" tables are shown
--            for contrast and MUST remain readable:
--              lld_code_files, lld_class_diagrams, interview_questions,
--              user_problem_progress  (RLS-scoped to auth.uid()).
-- ============================================================================

SELECT
  c.relname                                            AS table_name,
  c.relrowsecurity                                     AS rls_enabled,
  COALESCE((
    SELECT string_agg(DISTINCT g.grantee, ', ' ORDER BY g.grantee)
    FROM information_schema.role_table_grants g
    WHERE g.table_schema = 'public'
      AND g.table_name   = c.relname
      AND g.privilege_type = 'SELECT'
      AND g.grantee IN ('anon', 'authenticated')
  ), '(none)')                                         AS select_grantees,
  COALESCE((
    SELECT string_agg(p.policyname || ' [' || array_to_string(p.roles, '/') || ']', '; ')
    FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = c.relname AND p.cmd IN ('SELECT', 'ALL')
  ), '(no SELECT policies)')                           AS select_policies
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'leetcode_company_problems', 'lld_problems', 'hld_questions',
    'lld_code_files', 'lld_class_diagrams', 'interview_questions',
    'user_problem_progress', 'subscriptions', 'usage'
  )
ORDER BY 1;

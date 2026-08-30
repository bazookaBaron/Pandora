-- ============================================================================
-- 09_lockdown_catalog_rls.sql
-- Purpose: stop the browser's supabase client (anon / authenticated keys) from
--          reading the three CATALOG LIST tables directly. After this, the free
--          tier caps enforced by /api/catalog/* can no longer be bypassed by
--          querying the base tables straight from the client.
--
--   • leetcode_company_problems   (DSA catalog)
--   • lld_problems                (LLD catalog)
--   • hld_questions               (HLD catalog)
--
-- All reads of these tables now go through the Express server, which uses the
-- SUPABASE_SERVICE_ROLE_KEY (bypasses RLS):
--   /api/catalog/dsa   /api/catalog/lld   /api/catalog/lld/:slug
--   /api/catalog/hld   /api/catalog/hld/:id
--   /api/catalog/search   /api/catalog/companies   /api/stats/overview
--
-- NOT touched by this script (still reached by the RLS-scoped client, either
-- per-user or only after the catalog gate):
--   lld_code_files, lld_class_diagrams, interview_questions,
--   user_problem_progress, subscriptions, usage
--
-- Idempotent. Reversible (see the commented GRANTs at the bottom).
-- Run in the Supabase SQL Editor.
-- ============================================================================

-- 1. Enable RLS. With RLS on and no permissive SELECT policy for anon /
--    authenticated, PostgREST returns zero rows for those roles.
ALTER TABLE public.leetcode_company_problems ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lld_problems              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hld_questions             ENABLE ROW LEVEL SECURITY;

-- 2. Belt-and-braces: REVOKE the table privileges from the client roles so the
--    tables stay unreadable/unwritable even if a permissive policy is added
--    later by mistake. service_role is unaffected (it bypasses grants + RLS).
REVOKE SELECT, INSERT, UPDATE, DELETE
  ON public.leetcode_company_problems FROM anon, authenticated;
REVOKE SELECT, INSERT, UPDATE, DELETE
  ON public.lld_problems              FROM anon, authenticated;
REVOKE SELECT, INSERT, UPDATE, DELETE
  ON public.hld_questions             FROM anon, authenticated;

-- 3. Drop any pre-existing permissive SELECT policies that would re-open a read
--    path for the client roles. Uncomment + adjust names if 00_introspect /
--    the check query below shows policies on these tables. (Left commented so
--    this script never silently removes a policy you meant to keep.)
-- DROP POLICY IF EXISTS "<policy name>" ON public.leetcode_company_problems;
-- DROP POLICY IF EXISTS "<policy name>" ON public.lld_problems;
-- DROP POLICY IF EXISTS "<policy name>" ON public.hld_questions;

-- ── Verify (expect rls_enabled = true, select_grantees = (none)) ─────────────
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
  ), '(none)')                                         AS select_grantees
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('leetcode_company_problems', 'lld_problems', 'hld_questions')
ORDER BY 1;

-- ============================================================================
-- REVERSE (paste into the SQL Editor to undo this script)
-- ============================================================================
-- GRANT SELECT ON public.leetcode_company_problems TO anon, authenticated;
-- GRANT SELECT ON public.lld_problems              TO anon, authenticated;
-- GRANT SELECT ON public.hld_questions             TO anon, authenticated;
-- -- Only disable RLS if it was disabled before you ran this script:
-- ALTER TABLE public.leetcode_company_problems DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.lld_problems              DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.hld_questions             DISABLE ROW LEVEL SECURITY;

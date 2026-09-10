-- ============================================================================
-- 17_catalog_indexes.sql
-- Purpose: add the missing query indexes on the CATALOG tables
--          (lld_problems, hld_questions, leetcode_company_problems) and on the
--          per-user progress table (user_problem_progress).
--
-- Why: sql/09_lockdown_catalog_rls.sql only enabled RLS + REVOKEd grants on the
--      three catalog tables; it created ZERO indexes. Every /api/catalog/* list
--      route does an unindexed `ORDER BY created_at DESC` sort, the LLD detail
--      route does an unindexed `WHERE slug = $1`, and /api/stats/overview does an
--      unindexed `WHERE user_id = $1 AND problem_type = 'dsa'`.
--
-- SAFE TO PASTE-AND-RUN in the Supabase SQL editor:
--   * The editor wraps a multi-statement run in a transaction, so plain
--     (non-CONCURRENTLY) CREATE INDEX is used here.
--   * These are small, read-mostly tables (~a few thousand rows each; catalog
--     tables are admin-edited rarely and NOT written by the crawler), so a
--     plain CREATE INDEX finishes in milliseconds and its brief write-lock is
--     a non-issue. On a large, write-hot table you would instead run each
--     `CREATE INDEX CONCURRENTLY ...` one statement at a time (outside a txn).
--   * Every statement is `IF NOT EXISTS`-guarded and idempotent.
--   * pg_trgm is a standard Supabase-supported extension.
-- ============================================================================

-- Trigram matching, needed for the GIN index on leetcode_company_problems.title.
-- Phase 1.1 will add Postgres-side ILIKE / trigram search on `title`; this puts
-- the extension + index in place ahead of that change.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ----------------------------------------------------------------------------
-- lld_problems
-- ----------------------------------------------------------------------------

-- Serves: GET /api/catalog/lld (list, every page load) -> ORDER BY created_at DESC
--         GET /api/catalog/lld/:slug free-tier allowed-set check
--             -> SELECT slug ... ORDER BY created_at DESC LIMIT n
CREATE INDEX IF NOT EXISTS idx_lld_problems_created_at
  ON public.lld_problems (created_at DESC);

-- Serves: GET /api/catalog/lld/:slug (detail) -> WHERE slug = $1
-- Plain (non-unique) btree: harmless if slug is already backed by a UNIQUE
-- constraint/index. Not created as UNIQUE here because a CREATE UNIQUE INDEX
-- would fail if any duplicate slug exists.
CREATE INDEX IF NOT EXISTS idx_lld_problems_slug
  ON public.lld_problems (slug);

-- ----------------------------------------------------------------------------
-- hld_questions
-- ----------------------------------------------------------------------------

-- Serves: GET /api/catalog/hld (list, every page load) -> ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_hld_questions_created_at
  ON public.hld_questions (created_at DESC);

-- NOTE: GET /api/catalog/hld/:id does WHERE id = $1. `id` is the primary key,
-- which already has a unique index, so no additional index is added for it.

-- ----------------------------------------------------------------------------
-- leetcode_company_problems
-- ----------------------------------------------------------------------------

-- Serves: Phase 1.1 Postgres-side title search (ILIKE '%...%' / trigram).
-- Today the DSA routes only ORDER BY id (PK), so this index has no effect yet;
-- it is added now so Phase 1.1 does not need a migration later.
-- NOTE: no GIN index on `company` yet -- that column is currently a JSON-encoded
-- *string*, not jsonb/array. Phase 1.1 migrates it, then indexes it.
CREATE INDEX IF NOT EXISTS idx_lcp_title_trgm
  ON public.leetcode_company_problems USING gin (title gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- user_problem_progress
-- ----------------------------------------------------------------------------

-- Serves: GET /api/stats/overview -> WHERE user_id = $1 AND problem_type = 'dsa'
-- sql/03_rls_user_problem_progress.sql only creates RLS policies -- it adds NO
-- index on (user_id, problem_type) or on (user_id) -- so this filter is
-- currently unindexed.
CREATE INDEX IF NOT EXISTS idx_upp_user_type
  ON public.user_problem_progress (user_id, problem_type);

-- ============================================================================
-- Optional: refresh planner statistics after the indexes exist.
ANALYZE public.lld_problems;
ANALYZE public.hld_questions;
ANALYZE public.leetcode_company_problems;
ANALYZE public.user_problem_progress;
-- ============================================================================

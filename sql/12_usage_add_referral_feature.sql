-- ============================================================================
-- 12_usage_add_referral_feature.sql
-- Extend the public.usage.feature CHECK to allow 'referral_request' so the
-- existing monthly-usage machinery (canAccess / incrementUsage / getPeriod /
-- increment_usage() RPC) works for referral posting with NO new table.
-- Idempotent. Run in the Supabase SQL Editor (after sql/06 + sql/07).
-- ============================================================================

ALTER TABLE public.usage DROP CONSTRAINT IF EXISTS usage_feature_check;

ALTER TABLE public.usage
  ADD CONSTRAINT usage_feature_check
  CHECK (feature IN ('hld_practice', 'resume_optimizer', 'ai_explanation', 'referral_request'));

-- Verify:
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'public.usage'::regclass AND contype = 'c';

-- ============================================================================
-- 33_referral_indexes.sql
-- Indexes for hot referral / alert / catalog-search paths. Idempotent.
-- Run AFTER 11, 17, 18.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Normalised company column so /api/referrals/open can use an equality lookup
-- (target_company_norm = lower(btrim(my company))) instead of a seq-scan ilike.
ALTER TABLE public.referral_requests
  ADD COLUMN IF NOT EXISTS target_company_norm text
  GENERATED ALWAYS AS (lower(btrim(target_company))) STORED;

CREATE INDEX IF NOT EXISTS idx_referral_open_company_norm
  ON public.referral_requests (target_company_norm, created_at DESC)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_referral_accepted_by
  ON public.referral_requests (accepted_by_user_id)
  WHERE accepted_by_user_id IS NOT NULL;

-- Digest dedupe log: lookups by posting id (PK is (user_id, job_posting_id)).
CREATE INDEX IF NOT EXISTS idx_company_subscription_alerts_sent_posting
  ON public.company_subscription_alerts_sent (job_posting_id);

-- Prefix / contains search on profile companies (/api/profiles/companies).
CREATE INDEX IF NOT EXISTS idx_profiles_company_lower
  ON public.profiles (lower(company) text_pattern_ops)
  WHERE company IS NOT NULL;

-- DSA catalog topics ILIKE search (topics is a comma-separated text column).
-- Guarded: only created when the column is plain text.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'leetcode_company_problems'
       AND column_name = 'topics' AND data_type IN ('text', 'character varying')
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_leetcode_company_problems_topics_trgm
             ON public.leetcode_company_problems USING gin (topics gin_trgm_ops)';
  END IF;
END $$;

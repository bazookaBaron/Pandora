-- ============================================================================
-- 18_company_subscriptions.sql — "Subscribe to a company" job-alert feature.
-- Idempotent. Run in the Supabase SQL Editor.
--
-- FEATURE
--  Logged-in Pro/Max users subscribe to a company from its /jobs/company/:slug
--  hub page. A daily cron digest (server.js: sendCompanySubscriptionDigest,
--  "30 5 * * *") emails each subscriber one batched summary of new postings
--  for their subscribed companies in the last 24h. Free users: 0 slots (locked
--  out). Pro: 4. Max: 10 (a deliberately finite ceiling — see config/tiers.js).
--
-- SECURITY MODEL (mirrors sql/11_referral.sql's referral_requests shape)
--  • company_subscriptions: a user may SELECT only their own rows. ALL writes
--    (insert/delete) go through the Express server with the service-role key,
--    because adding a row must pass the plan-based count-cap gate
--    (lib/entitlements.js: canAddCompanySubscription) — a client-side insert
--    would bypass that check.
--  • company_subscription_alerts_sent is a server-only dedup log (never read
--    or written by the browser) so a retried/overlapping cron run can never
--    double-send an alert for the same (user, job posting) pair.
--
-- CROSS-SCHEMA NOTE
--  crawler.company / crawler.job_posting live in the `crawler` schema of the
--  same physical database (owned by the separate job-crawler repo). The FK
--  below and the join function further down both reference them directly —
--  this works fine within one Postgres database across schemas.
-- ============================================================================

-- ── company_subscriptions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.company_subscriptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_slug   text NOT NULL REFERENCES crawler.company(slug),
  company_name   text NOT NULL,   -- denormalized display name, avoids a join on every render/email
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, company_slug)
);

CREATE INDEX IF NOT EXISTS idx_company_subscriptions_slug
  ON public.company_subscriptions (company_slug);
CREATE INDEX IF NOT EXISTS idx_company_subscriptions_user
  ON public.company_subscriptions (user_id);

ALTER TABLE public.company_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company_subscriptions_select_own" ON public.company_subscriptions;
CREATE POLICY "company_subscriptions_select_own" ON public.company_subscriptions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- NO insert/update/delete policies for the client — the count-cap gate must
-- run server-side before every insert. Belt-and-suspenders: strip base grants.
REVOKE INSERT, UPDATE, DELETE ON public.company_subscriptions FROM anon, authenticated;
REVOKE ALL ON public.company_subscriptions FROM anon;

-- ── company_subscription_alerts_sent (dedup log, server-only) ──────────────
-- job_posting_id matches crawler.job_posting.id, which is `bigint GENERATED
-- ALWAYS AS IDENTITY` (verified against job-crawler's src/pgpipe/schema.sql).
CREATE TABLE IF NOT EXISTS public.company_subscription_alerts_sent (
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_posting_id  bigint NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, job_posting_id)
);

-- Prune sweep (part of the digest cron run) scans/deletes by sent_at.
CREATE INDEX IF NOT EXISTS idx_company_subscription_alerts_sent_sent_at
  ON public.company_subscription_alerts_sent (sent_at);

ALTER TABLE public.company_subscription_alerts_sent ENABLE ROW LEVEL SECURITY;
-- No policies at all for anon/authenticated — this table is never read or
-- written by the browser, only by the service-role cron job.
REVOKE ALL ON public.company_subscription_alerts_sent FROM anon, authenticated;

-- ── helper: cross-schema join for the digest cron ───────────────────────────
-- PostgREST/supabase-js can't join across schemas in one call, and pulling
-- every company_subscriptions row into the app just to build an .in() filter
-- would ship a lot of rows for nothing. This SQL function does the
-- restriction as a real join (EXISTS semi-join) at the database level: job
-- postings newer than `since`, limited to companies that have at least one
-- subscriber. The server then fetches the (much smaller) subscriber list only
-- for the company_slugs this returns.
CREATE OR REPLACE FUNCTION public.company_subscription_new_postings(since timestamptz)
RETURNS TABLE (
  id             bigint,
  company_slug   text,
  title          text,
  location       text,
  seniority      text,
  url            text,
  first_seen_at  timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, crawler AS $$
  SELECT jp.id, jp.company_slug, jp.title, jp.location, jp.seniority, jp.url, jp.first_seen_at
  FROM crawler.job_posting jp
  WHERE jp.status = 'open'
    AND jp.first_seen_at >= since
    AND EXISTS (
      SELECT 1 FROM public.company_subscriptions cs
      WHERE cs.company_slug = jp.company_slug
    )
$$;

REVOKE ALL ON FUNCTION public.company_subscription_new_postings(timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION public.company_subscription_new_postings(timestamptz) TO service_role;

-- ── verify ─────────────────────────────────────────────────────────────
-- SELECT tablename, policyname, cmd, roles FROM pg_policies
--   WHERE tablename IN ('company_subscriptions','company_subscription_alerts_sent') ORDER BY 1,2;
-- SELECT * FROM public.company_subscription_new_postings(now() - interval '24 hours') LIMIT 5;

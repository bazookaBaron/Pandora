-- ============================================================================
-- 49_recurring_subscriptions.sql
-- Pro / Max become true Razorpay recurring subscriptions. Adds:
--   subscriptions.cancel_at_period_end  user cancelled; access runs to current_period_end
--   subscriptions.cancelled_at
--   subscriptions.grace_until           3-day grace after a failed renewal (past_due)
--   subscriptions.currency              'INR' | 'USD' the subscription bills in
--   subscriptions.admin_grant           legacy manual grant: an ACTIVE paid row with
--                                       NO current_period_end is honoured ONLY if true
--   subscriptions.pending_plan          Pro<->Max change scheduled for next renewal
--   subscriptions.last_event_at         newest webhook event applied (stale-event guard)
--   profiles.country_source             'header' | 'ip' | 'user' (how country was set)
-- Idempotent. Run in the Supabase SQL Editor AFTER 06, 16, 28, 29. Nothing here
-- runs automatically. Safe to apply BEFORE deploying the app: the server falls
-- back to the old column list if this has not been applied yet.
-- ============================================================================

ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS grace_until timestamptz;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS admin_grant boolean NOT NULL DEFAULT false;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS pending_plan text;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS last_event_at timestamptz;

ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_currency_check;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_currency_check CHECK (currency IS NULL OR currency IN ('INR','USD'));
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_pending_plan_check;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_pending_plan_check CHECK (pending_plan IS NULL OR pending_plan IN ('pro','max'));

-- Legacy manual grants: paid + active + no period end + no payment provider.
-- These were honoured forever by the old entitlement check; keep them that way
-- explicitly. Review this list before running; anything else active with no
-- period end becomes Free by design.
UPDATE public.subscriptions
   SET admin_grant = true
 WHERE plan <> 'free'
   AND status = 'active'
   AND current_period_end IS NULL
   AND (provider IS NULL OR provider IN ('manual', 'admin'));

-- Legacy one-time Razorpay terms keep their current_period_end and simply end.
-- Tag their currency from the payment audit where we know it.
UPDATE public.subscriptions s
   SET currency = p.currency
  FROM (
    SELECT DISTINCT ON (user_id) user_id, currency
      FROM public.processed_payments
     WHERE currency IN ('INR','USD')
     ORDER BY user_id, created_at DESC
  ) p
 WHERE s.user_id = p.user_id AND s.currency IS NULL AND s.plan <> 'free';

CREATE INDEX IF NOT EXISTS idx_subscriptions_grace
  ON public.subscriptions (grace_until)
  WHERE grace_until IS NOT NULL;

-- ── profiles.country_source ──────────────────────────────────────────────────
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS country_source text;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_country_source_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_country_source_check CHECK (country_source IS NULL OR country_source IN ('header','ip','user'));

-- Every country stored so far came from IP detection: mark it so the next login
-- re-detects it (a trusted Cloudflare header, or a corrected geoip, wins).
UPDATE public.profiles SET country_source = 'ip' WHERE country IS NOT NULL AND country_source IS NULL;

-- Server-only, same as profiles.country (sql/29).
REVOKE INSERT (country_source), UPDATE (country_source) ON public.profiles FROM anon, authenticated;

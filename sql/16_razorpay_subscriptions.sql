-- ============================================================================
-- 16_razorpay_subscriptions.sql — Razorpay Subscriptions support
--   • extra columns on public.subscriptions to mirror the Razorpay admin panel
--     (Subscription Id, Plan Id, Subscription Link, Customer Id, Next Due on)
--   • widen the status CHECK to accept Razorpay subscription statuses
--   • profiles.razorpay_customer_id  (reuse one customer per user)
-- Idempotent. Run in the Supabase SQL Editor AFTER sql/06 and sql/11.
-- ============================================================================

-- provider_subscription_id / provider_customer_id / current_period_end already
-- exist (sql/06). Add the two that don't:
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS provider_plan_id text;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS subscription_short_url text; -- "Subscription Link"

-- Column ⇄ admin-panel mapping:
--   Subscription Id   -> provider_subscription_id
--   Plan Id           -> provider_plan_id
--   Subscription Link -> subscription_short_url
--   Customer Id       -> provider_customer_id
--   Next Due on       -> current_period_end
--   Created At        -> created_at
--   Status            -> status

-- Widen the status CHECK to also allow Razorpay subscription statuses.
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN (
    -- app statuses (kept from sql/06)
    'active','cancelled','expired','past_due','paused','on_trial',
    -- Razorpay subscription statuses
    'created','authenticated','pending','halted','completed'
  ));

-- One reusable Razorpay customer per user.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS razorpay_customer_id text;

CREATE INDEX IF NOT EXISTS idx_subscriptions_provider_sub
  ON public.subscriptions (provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

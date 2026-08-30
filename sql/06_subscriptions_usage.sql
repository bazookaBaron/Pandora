-- ============================================================================
-- 06_subscriptions_usage.sql
-- Entitlement system: subscriptions + usage tables, RLS, signup trigger,
-- and a backfill for existing users. Idempotent. Run in the Supabase SQL Editor.
--
-- Model:
--  • subscriptions: one row per user. Defaults to plan='free', status='active',
--    provider=NULL. Updated ONLY by the server (service role) — e.g. from the
--    Lemon Squeezy webhook. Users may SELECT their own row only.
--  • usage: monthly-resetting counters for metered features
--    (hld_practice, resume_optimizer, ai_explanation). Written ONLY by the
--    server (service role). Users may SELECT their own rows only.
-- ============================================================================

-- ── subscriptions ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan                      text NOT NULL DEFAULT 'free'
                              CHECK (plan IN ('free','pro','max')),
  status                    text NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','cancelled','expired','past_due','paused','on_trial')),
  provider                  text,
  provider_customer_id      text,
  provider_subscription_id  text UNIQUE,
  billing_period            text CHECK (billing_period IN ('monthly','yearly')),
  current_period_end        timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_user ON public.subscriptions(user_id);

-- ── usage ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.usage (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature       text NOT NULL CHECK (feature IN ('hld_practice','resume_optimizer','ai_explanation')),
  usage_count   integer NOT NULL DEFAULT 0,
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, feature, period_start)
);
CREATE INDEX IF NOT EXISTS idx_usage_user_feature ON public.usage(user_id, feature);

-- ── updated_at touch trigger (shared) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_subscriptions_touch ON public.subscriptions;
CREATE TRIGGER trg_subscriptions_touch BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_usage_touch ON public.usage;
CREATE TRIGGER trg_usage_touch BEFORE UPDATE ON public.usage
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── RLS: users read their own rows; writes are service-role only ──────────
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "subscriptions_select_own" ON public.subscriptions;
CREATE POLICY "subscriptions_select_own" ON public.subscriptions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "usage_select_own" ON public.usage;
CREATE POLICY "usage_select_own" ON public.usage
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies for the `authenticated` role => the anon /
-- authenticated API keys cannot write these tables at all. The server uses the
-- service_role key, which bypasses RLS.

-- Make sure the authenticated role can't write even if a policy is added later
REVOKE INSERT, UPDATE, DELETE ON public.subscriptions FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.usage         FROM authenticated, anon;

-- ── Signup trigger: every new auth user gets a free subscriptions row ─────
-- Fires for BOTH email/password and OAuth (Google) signups.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.subscriptions (user_id, plan, status, provider)
  VALUES (NEW.id, 'free', 'active', NULL)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── Backfill: existing users with no subscriptions row ───────────────────
INSERT INTO public.subscriptions (user_id, plan, status, provider)
SELECT u.id, 'free', 'active', NULL
FROM auth.users u
LEFT JOIN public.subscriptions s ON s.user_id = u.id
WHERE s.id IS NULL;

-- ── Verify ──────────────────────────────────────────────────────────────
-- SELECT plan, status, count(*) FROM public.subscriptions GROUP BY 1,2;
-- SELECT tablename, policyname, cmd, roles FROM pg_policies
--   WHERE tablename IN ('subscriptions','usage') ORDER BY 1,2;

-- ============================================================================
-- 31_profiles_column_lock.sql
-- Close the profiles self-update hole (sql/11 allowed UPDATE of ANY column on
-- the user's own row, so a user could rewrite country, razorpay_customer_id or
-- claim any `company` and read that company's referral requests).
--
--   1. Column-level privileges: authenticated/anon may only INSERT/UPDATE the
--      columns the client legitimately writes. country, razorpay_customer_id and
--      the company_verified* columns are server-only (service_role).
--   2. profiles.company_verified (+ verified_at / verified_domain). A user may
--      still type a company (ProfilePage upserts it), but a trigger forces
--      company_verified=false whenever the client inserts a profile or changes
--      `company`. Only the server (work-email code flow) can set it to true.
--   3. my_company() returns the company ONLY when company_verified, so the
--      referral_requests RLS policy and every my_company() caller are gated.
--   4. company_verification_codes: hashed 6-digit codes for work-email proof.
-- Idempotent. Run AFTER 11, 15, 16, 19.
--
-- SUPERSEDED IN PART by sql/35_optional_company_verify.sql: verification is now
-- optional (badge + higher accept limit), so 35 re-creates my_company() to
-- return the company regardless of company_verified and tightens the
-- referral_requests RLS. ALWAYS run 35 after 31 (31 then 35 is the final
-- state; re-running 31 alone would re-impose the mandatory gate until 35 runs).
--
-- NOTE: existing users will have company_verified=false and lose referral
-- visibility until they verify. To grandfather everyone, uncomment the UPDATE
-- at the bottom (not recommended - that is the exploit this file closes).
-- ============================================================================

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS company_verified boolean NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS company_verified_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS company_verified_domain text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS country text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS razorpay_customer_id text;

-- ── trigger: client-originated company edits are never "verified" ───────────
CREATE OR REPLACE FUNCTION public.profiles_guard_company()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- service_role / postgres / dashboard edits pass through untouched.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.company_verified := false;
    NEW.company_verified_at := NULL;
    NEW.company_verified_domain := NULL;
  ELSE
    IF NEW.company IS DISTINCT FROM OLD.company THEN
      NEW.company_verified := false;
      NEW.company_verified_at := NULL;
      NEW.company_verified_domain := NULL;
    ELSE
      NEW.company_verified := OLD.company_verified;
      NEW.company_verified_at := OLD.company_verified_at;
      NEW.company_verified_domain := OLD.company_verified_domain;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_profiles_guard_company ON public.profiles;
CREATE TRIGGER trg_profiles_guard_company
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_guard_company();

-- ── column privileges ──────────────────────────────────────────────────────
REVOKE INSERT, UPDATE ON public.profiles FROM authenticated, anon;
GRANT INSERT (id, company, position, years_of_experience, receive_referral_notifications, avatar_url)
  ON public.profiles TO authenticated;
GRANT UPDATE (company, position, years_of_experience, receive_referral_notifications, avatar_url)
  ON public.profiles TO authenticated;
-- SELECT stays governed by the profiles_select_own policy (sql/11).

-- ── my_company(): (superseded by sql/35 - now returns company regardless) ──
CREATE OR REPLACE FUNCTION public.my_company()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT company FROM public.profiles WHERE id = auth.uid() AND company_verified = true
$$;
REVOKE ALL ON FUNCTION public.my_company() FROM public;
GRANT EXECUTE ON FUNCTION public.my_company() TO authenticated;

-- ── work-email verification codes (server only) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.company_verification_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company       text NOT NULL,
  work_email    text NOT NULL,
  email_domain  text NOT NULL,
  code_hash     text NOT NULL,           -- sha256(user_id|code|server secret)
  attempts      integer NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_company_verif_user ON public.company_verification_codes (user_id, created_at DESC);
ALTER TABLE public.company_verification_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_verification_codes FROM anon, authenticated;
GRANT ALL ON public.company_verification_codes TO service_role;

-- Optional grandfathering (NOT recommended):
-- UPDATE public.profiles SET company_verified = true, company_verified_at = now() WHERE company IS NOT NULL;

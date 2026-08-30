-- ============================================================================
-- 11_referral.sql  —  Referral request panel: profiles + referral_requests +
-- RLS + indexes + private storage bucket + signup trigger extension.
-- Idempotent. Run in the Supabase SQL Editor AFTER sql/06 and sql/12.
--
-- SECURITY MODEL
--  • profiles: a user reads/updates/inserts ONLY their own row (RLS). Other
--    users' company/position are NOT exposed to the browser — "matching" is
--    done server-side with the service-role key (email fan-out, browse filter),
--    and the signup company autocomplete is served by GET /api/profiles/companies.
--    (This is stricter than "readable by other authenticated users" but meets
--    the actual requirement and leaks less.)
--  • referral_requests: the browser may only SELECT (a) its own rows (any
--    status) and (b) other users' rows that are status='open' AND target the
--    user's own company. ALL writes (insert/accept/cancel/expire) go through
--    the Express server with the service-role key — the client cannot insert
--    (that would bypass the monthly quota check) or update (accept must be an
--    atomic server-side conditional update).
--  • Storage bucket 'referral-resumes' is PRIVATE with no storage.objects
--    policies for anon/authenticated → every upload and every signed URL is
--    produced server-side by the service role. Re-checked on each request.
-- ============================================================================

-- ── profiles ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id                              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  company                         text,
  position                        text,
  years_of_experience             numeric,
  receive_referral_notifications  boolean NOT NULL DEFAULT true,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

-- If the table already existed without these columns, add them.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS company text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS position text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS years_of_experience numeric;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS receive_referral_notifications boolean NOT NULL DEFAULT true;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_profiles_company ON public.profiles (company) WHERE company IS NOT NULL;

DROP TRIGGER IF EXISTS trg_profiles_touch ON public.profiles;
CREATE TRIGGER trg_profiles_touch BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();   -- from sql/06

-- ── referral_requests ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.referral_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poster_user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_company        text NOT NULL,
  job_id                text,
  job_title             text,
  resume_storage_path   text NOT NULL,
  status                text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','accepted','cancelled','expired')),
  accepted_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);

-- One OPEN request per poster.
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_one_open_per_user
  ON public.referral_requests (poster_user_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_referral_target_company_status
  ON public.referral_requests (target_company, status);
CREATE INDEX IF NOT EXISTS idx_referral_poster ON public.referral_requests (poster_user_id);
CREATE INDEX IF NOT EXISTS idx_referral_expiry
  ON public.referral_requests (expires_at) WHERE status = 'open';

DROP TRIGGER IF EXISTS trg_referral_requests_touch ON public.referral_requests;
CREATE TRIGGER trg_referral_requests_touch BEFORE UPDATE ON public.referral_requests
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── helper: caller's own company (STABLE, definer) for the RLS policy ───────
CREATE OR REPLACE FUNCTION public.my_company()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT company FROM public.profiles WHERE id = auth.uid()
$$;
REVOKE ALL ON FUNCTION public.my_company() FROM public;
GRANT EXECUTE ON FUNCTION public.my_company() TO authenticated;

-- ── RLS: profiles ─────────────────────────────────────────────────────────
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- no DELETE policy; block stray grants
REVOKE DELETE ON public.profiles FROM anon, authenticated;
REVOKE ALL ON public.profiles FROM anon;

-- ── RLS: referral_requests ───────────────────────────────────────────────
ALTER TABLE public.referral_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "referral_requests_select_visible" ON public.referral_requests;
CREATE POLICY "referral_requests_select_visible" ON public.referral_requests
  FOR SELECT TO authenticated
  USING (
    poster_user_id = auth.uid()
    OR (
      status = 'open'
      AND public.my_company() IS NOT NULL
      AND target_company = public.my_company()
    )
  );

-- NO insert/update/delete policies for the client. All writes are server-side
-- (service role bypasses RLS). Belt-and-suspenders: strip the base grants.
REVOKE INSERT, UPDATE, DELETE ON public.referral_requests FROM anon, authenticated;
REVOKE ALL ON public.referral_requests FROM anon;

-- ── private storage bucket for referral resumes ─────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('referral-resumes', 'referral-resumes', false)
ON CONFLICT (id) DO NOTHING;
-- Intentionally NO storage.objects RLS policies for anon/authenticated:
-- uploads + signed URLs are produced only by the service-role server.

-- ── signup trigger: also create a profiles row (email signup can pass
--    company/position/years_of_experience via auth options.data) ───────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  raw jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
  yoe_txt text := NULLIF(trim(raw->>'years_of_experience'), '');
BEGIN
  INSERT INTO public.subscriptions (user_id, plan, status, provider)
  VALUES (NEW.id, 'free', 'active', NULL)
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.profiles (id, company, position, years_of_experience)
  VALUES (
    NEW.id,
    NULLIF(trim(raw->>'company'), ''),
    NULLIF(trim(raw->>'position'), ''),
    CASE WHEN yoe_txt ~ '^[0-9]+(\.[0-9]+)?$' THEN yoe_txt::numeric ELSE NULL END
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── backfill: profiles row for every existing user without one ───────────
INSERT INTO public.profiles (id)
SELECT u.id FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL;

-- ── verify ─────────────────────────────────────────────────────────────
-- SELECT count(*) FROM public.profiles;
-- SELECT tablename, policyname, cmd, roles FROM pg_policies
--   WHERE tablename IN ('profiles','referral_requests') ORDER BY 1,2;
-- SELECT id, public FROM storage.buckets WHERE id = 'referral-resumes';

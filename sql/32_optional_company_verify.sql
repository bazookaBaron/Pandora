-- ============================================================================
-- 32_optional_company_verify.sql
-- (Renumbered from sql/35 on integration/audit-fixes-autoapply. Apply order: 28, 29, 30, 31, 32.)
-- Work-email company verification becomes OPTIONAL (badge + higher accept
-- limit) instead of mandatory. Supersedes the my_company() definition in
-- sql/29. Idempotent. Run AFTER 11, 29, 31 (it is safe to re-run 29 first:
-- 29 only redefines my_company() and 32 then restores the final definition).
--
--   1. my_company() returns the caller's company regardless of verification.
--      It is still used only for display; it no longer grants any data access.
--   2. referral_requests is no longer readable by company membership. The old
--      policy let any authenticated user whose profiles.company matched
--      target_company SELECT every open row directly through PostgREST,
--      including resume_storage_path. Now a client can SELECT only rows it
--      posted or accepted. The open-requests list for a company is served by
--      the Express server (service role), which returns no resume path / email.
--   3. Column-level SELECT: resume_storage_path is never readable by the
--      browser roles (the server signs URLs; only requester + accepter get one,
--      see lib/referralAccess.js canViewResume()).
--   4. Index supporting the rolling-24h accept-limit count.
-- ============================================================================

-- 1. my_company(): company regardless of verification.
CREATE OR REPLACE FUNCTION public.my_company()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT company FROM public.profiles WHERE id = auth.uid()
$$;
REVOKE ALL ON FUNCTION public.my_company() FROM public;
GRANT EXECUTE ON FUNCTION public.my_company() TO authenticated;

-- 2. RLS: only the requester and the accepter can see a row.
DROP POLICY IF EXISTS "referral_requests_select_visible" ON public.referral_requests;
CREATE POLICY "referral_requests_select_visible" ON public.referral_requests
  FOR SELECT TO authenticated
  USING (poster_user_id = auth.uid() OR accepted_by_user_id = auth.uid());

-- 3. Column privileges: hide the storage path (and keep everything else the
--    client could plausibly show). Table-level SELECT must be revoked first,
--    otherwise a column-level REVOKE is a no-op.
REVOKE SELECT ON public.referral_requests FROM anon, authenticated;
GRANT SELECT (
  id, poster_user_id, target_company, job_id, job_title, status,
  accepted_by_user_id, accepted_at, created_at, updated_at, expires_at
) ON public.referral_requests TO authenticated;
-- target_company_norm (sql/31) is intentionally not granted; server-only.

-- 4. Accept-limit lookups: WHERE accepted_by_user_id = $1 AND accepted_at > $2
CREATE INDEX IF NOT EXISTS idx_referral_accepted_by_at
  ON public.referral_requests (accepted_by_user_id, accepted_at DESC)
  WHERE accepted_by_user_id IS NOT NULL;

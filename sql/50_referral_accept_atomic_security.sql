-- 50_referral_accept_atomic_security.sql
-- The rolling-24h accept cap was check-then-update in Node, so N parallel accepts all passed the check.
-- This function serialises per accepting user (advisory xact lock), counts inside the same transaction
-- and performs the conditional claim. Raises 'accept_limit' when over the cap; returns 0 rows when the
-- request is no longer open / does not match (caller maps that to already_accepted).
CREATE OR REPLACE FUNCTION public.accept_referral_request(
  p_id uuid, p_user uuid, p_company_norm text, p_limit integer, p_window interval DEFAULT interval '24 hours'
) RETURNS SETOF public.referral_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('referral_accept:' || p_user::text, 0));
  SELECT count(*) INTO n FROM public.referral_requests
   WHERE accepted_by_user_id = p_user AND accepted_at > now() - p_window;
  IF n >= p_limit THEN RAISE EXCEPTION 'accept_limit'; END IF;
  RETURN QUERY
  UPDATE public.referral_requests r
     SET status = 'accepted', accepted_by_user_id = p_user, accepted_at = now()
   WHERE r.id = p_id AND r.status = 'open'
     AND r.target_company_norm = p_company_norm
     AND r.poster_user_id <> p_user
  RETURNING r.*;
END $$;

REVOKE EXECUTE ON FUNCTION public.accept_referral_request(uuid, uuid, text, integer, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_referral_request(uuid, uuid, text, integer, interval) TO service_role;

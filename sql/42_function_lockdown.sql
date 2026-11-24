-- 42_function_lockdown.sql — security advisor fixes for public.* functions.
--
-- 1. get_company_readiness(p_user_id): was SECURITY DEFINER, callable by anon, ignored p_user_id and counted
--    every user's progress. Now SECURITY INVOKER with a fixed search_path. The effective user is auth.uid()
--    for signed-in callers (p_user_id is ignored for them); only the service role (the server,
--    server.js /api/stats) may pass p_user_id. Signature unchanged.
-- 2. EXECUTE revoked from anon / PUBLIC on SECURITY DEFINER functions that must not be anonymous:
--    company_subscription_new_postings (server-only; also revoked from authenticated), my_company
--    (authenticated keeps it: the referral_requests RLS policy calls it), handle_new_user (trigger function:
--    EXECUTE is only checked at CREATE TRIGGER time, the on_auth_user_created trigger keeps firing).
-- 3. Fixed search_path on the public functions the advisor lists as mutable.

CREATE OR REPLACE FUNCTION public.get_company_readiness(p_user_id uuid)
RETURNS TABLE (company_name text, problem_type text, total bigint, solved bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT CASE WHEN auth.role() = 'service_role' THEN p_user_id ELSE auth.uid() END AS uid
  ),
  t AS (
    SELECT unnest(l.companies) AS company_name, l.id AS problem_id, 'lld'::text AS problem_type FROM public.lld_problems l
    UNION ALL
    SELECT unnest(c.company), c.id, 'dsa'::text FROM public.leetcode_company_problems c
  )
  SELECT t.company_name, t.problem_type, count(*)::bigint AS total,
         count(upp.problem_id)::bigint AS solved
    FROM t
    CROSS JOIN me
    LEFT JOIN public.user_problem_progress upp
      ON upp.problem_id = t.problem_id AND upp.problem_type = t.problem_type
     AND upp.user_id = me.uid AND upp.status = 'solved'
   GROUP BY t.company_name, t.problem_type;
$$;
REVOKE ALL ON FUNCTION public.get_company_readiness(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_company_readiness(uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.company_subscription_new_postings(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.company_subscription_new_postings(timestamptz) TO service_role;

REVOKE EXECUTE ON FUNCTION public.my_company() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_company() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

ALTER FUNCTION public.upsert_leetcode_problem(text, text, text, numeric, numeric, text, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.remove_company_from_problem(text, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.update_lld_problems_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.update_hld_questions_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.touch_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.profiles_guard_company() SET search_path = public, pg_temp;

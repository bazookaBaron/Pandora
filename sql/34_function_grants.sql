-- ============================================================================
-- 34_function_grants.sql
-- Lock down SECURITY DEFINER functions that must only run server-side.
-- PostgREST exposes every function in `public` to anon/authenticated by default
-- (EXECUTE is granted to PUBLIC), so a SECURITY DEFINER function taking a
-- user id lets any signed-in user call it for ANY user id.
--
--   * get_company_readiness(p_user_id) is called by the server
--     (/api/stats/overview) but is not defined in sql/. If it exists in your
--     database it is revoked from anon/authenticated here; the server calls it
--     with the service role.
--   * Other SECURITY DEFINER functions that take a caller-supplied user id.
-- Guarded: does nothing for functions that do not exist. Idempotent.
-- ============================================================================

DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'get_company_readiness',
         'increment_usage',
         'reserve_usage',
         'refund_usage',
         'company_subscription_new_postings',
         'handle_new_user'
       )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.sig);
  END LOOP;
END $$;

-- Review any other SECURITY DEFINER functions in public that anon/authenticated can execute:
--   SELECT p.oid::regprocedure, p.prosecdef
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.prosecdef
--      AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
-- (my_company() is intentionally executable by authenticated - it is used by an RLS policy.)

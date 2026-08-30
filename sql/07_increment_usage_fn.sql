-- ============================================================================
-- 07_increment_usage_fn.sql
-- Atomic, concurrency-safe increment for the `public.usage` counter table.
-- Run in the Supabase SQL Editor AFTER 06_subscriptions_usage.sql.
--
-- The server calls this via PostgREST RPC:
--   supabaseAdmin.rpc('increment_usage', {
--     p_user_id, p_feature, p_period_start, p_period_end
--   })
--
-- One INSERT ... ON CONFLICT DO UPDATE statement => two rapid calls always
-- land on usage_count = 2, not 1 (no read-then-write race window).
-- SECURITY DEFINER + a locked-down search_path so it runs with the owner's
-- rights; EXECUTE is granted to service_role only.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.increment_usage(
  p_user_id      uuid,
  p_feature      text,
  p_period_start timestamptz,
  p_period_end   timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_count integer;
BEGIN
  IF p_feature NOT IN ('hld_practice','resume_optimizer','ai_explanation') THEN
    RAISE EXCEPTION 'invalid feature: %', p_feature;
  END IF;

  INSERT INTO public.usage (user_id, feature, usage_count, period_start, period_end)
  VALUES (p_user_id, p_feature, 1, p_period_start, p_period_end)
  ON CONFLICT (user_id, feature, period_start)
  DO UPDATE SET usage_count = public.usage.usage_count + 1,
               updated_at   = now()
  RETURNING usage_count INTO new_count;

  RETURN new_count;
END $$;

-- Only the server (service_role) may call it. Revoke from the public API roles.
REVOKE ALL ON FUNCTION public.increment_usage(uuid, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_usage(uuid, text, timestamptz, timestamptz) TO service_role;

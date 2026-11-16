-- ============================================================================
-- 30_usage_reserve.sql
-- (Renumbered from sql/32 on integration/audit-fixes-autoapply. Apply order: 28, 29, 30, 31, 32.)
-- Atomic reserve-then-refund quota accounting. Replaces the racy
-- canAccess() -> work -> incrementUsage() pattern: reserve_usage() increments
-- ONLY IF the counter is still below the limit, in one statement, so N parallel
-- requests can never overshoot. refund_usage() undoes a reservation when the
-- gated work fails. Run AFTER 06/07/12. SECURITY DEFINER, service_role only.
-- ============================================================================

-- Returns the new usage_count, or -1 when the limit is already reached.
CREATE OR REPLACE FUNCTION public.reserve_usage(
  p_user         uuid,
  p_feature      text,
  p_limit        integer,
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
  IF p_feature NOT IN ('hld_practice','resume_optimizer','ai_explanation','referral_request') THEN
    RAISE EXCEPTION 'invalid feature: %', p_feature;
  END IF;
  IF p_limit IS NULL OR p_limit <= 0 THEN
    RETURN -1;
  END IF;

  INSERT INTO public.usage (user_id, feature, usage_count, period_start, period_end)
  VALUES (p_user, p_feature, 1, p_period_start, p_period_end)
  ON CONFLICT (user_id, feature, period_start)
  DO UPDATE SET usage_count = public.usage.usage_count + 1,
               updated_at   = now()
    WHERE public.usage.usage_count < p_limit
  RETURNING usage_count INTO new_count;

  IF new_count IS NULL THEN
    RETURN -1;  -- row exists and is at/over the limit
  END IF;
  RETURN new_count;
END $$;

CREATE OR REPLACE FUNCTION public.refund_usage(
  p_user         uuid,
  p_feature      text,
  p_period_start timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_count integer;
BEGIN
  UPDATE public.usage
     SET usage_count = GREATEST(usage_count - 1, 0),
         updated_at  = now()
   WHERE user_id = p_user AND feature = p_feature AND period_start = p_period_start
  RETURNING usage_count INTO new_count;
  RETURN COALESCE(new_count, 0);
END $$;

REVOKE ALL ON FUNCTION public.reserve_usage(uuid, text, integer, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_usage(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_usage(uuid, text, integer, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_usage(uuid, text, timestamptz) TO service_role;

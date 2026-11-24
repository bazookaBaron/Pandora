-- 46_coupon_limits.sql — coupon fixes (NOT applied automatically; apply by hand).
--
--  1. per_user_limit is counted ACROSS targets: one user could redeem a free_all coupon twice (once for the
--     Max plan at /pricing and once for a free AutoApply 50-pack) because the count was per target.
--  2. coupons.max_pack_size: the largest AutoApply pack a coupon may be used for. NULL = the default:
--     50 for free_all, no limit for per_job_rupee. The server (lib/autoapply/orders.js) rejects a bigger pack
--     with coupon_not_applicable; redeem_coupon returns the effective limit.
-- redeem_coupon's result gains a column, so it is dropped and recreated (same arguments, same grants).

ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS max_pack_size integer CHECK (max_pack_size IS NULL OR max_pack_size > 0);
COMMENT ON COLUMN public.coupons.per_user_limit IS 'Redemptions per user across ALL targets (plan + autoapply); NULL = unlimited.';
COMMENT ON COLUMN public.coupons.max_pack_size IS 'Largest AutoApply pack this coupon applies to; NULL = 50 for free_all, unlimited for per_job_rupee.';

DROP FUNCTION IF EXISTS public.redeem_coupon(text, uuid, text, boolean);
CREATE FUNCTION public.redeem_coupon(p_code text, p_user uuid, p_target text, p_dry boolean DEFAULT false)
RETURNS TABLE (redemption_id uuid, kind text, plan text, max_pack_size integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c   public.coupons;
  n   integer;
  rid uuid;
BEGIN
  IF p_target NOT IN ('plan', 'autoapply') THEN RAISE EXCEPTION 'coupon_not_applicable'; END IF;
  IF p_dry THEN
    SELECT * INTO c FROM public.coupons WHERE code = upper(btrim(p_code));
  ELSE
    SELECT * INTO c FROM public.coupons WHERE code = upper(btrim(p_code)) FOR UPDATE;
  END IF;
  IF NOT FOUND OR NOT c.active OR (c.expires_at IS NOT NULL AND c.expires_at <= now()) THEN
    RAISE EXCEPTION 'coupon_invalid';
  END IF;
  IF c.kind = 'per_job_rupee' AND p_target <> 'autoapply' THEN RAISE EXCEPTION 'coupon_not_applicable'; END IF;
  IF c.max_uses IS NOT NULL AND c.uses >= c.max_uses THEN RAISE EXCEPTION 'coupon_used_up'; END IF;
  IF c.per_user_limit IS NOT NULL THEN
    -- across targets (was: AND r.target = p_target)
    SELECT count(*) INTO n FROM public.coupon_redemptions r WHERE r.code = c.code AND r.user_id = p_user;
    IF n >= c.per_user_limit THEN RAISE EXCEPTION 'coupon_already_used'; END IF;
  END IF;
  IF NOT p_dry THEN
    UPDATE public.coupons SET uses = uses + 1 WHERE code = c.code;
    INSERT INTO public.coupon_redemptions (code, user_id, target) VALUES (c.code, p_user, p_target) RETURNING id INTO rid;
  END IF;
  RETURN QUERY SELECT rid, c.kind, c.plan,
    COALESCE(c.max_pack_size, CASE WHEN c.kind = 'free_all' THEN 50 ELSE NULL END);
END $$;

REVOKE EXECUTE ON FUNCTION public.redeem_coupon(text, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_coupon(text, uuid, text, boolean) TO service_role;

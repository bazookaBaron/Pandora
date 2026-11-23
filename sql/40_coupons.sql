-- 40_coupons.sql — coupon codes for plan checkout and AutoApply packs.
--
-- kinds
--   free_all       : the plan (coupons.plan, default 'max') is granted free for one term at /pricing,
--                    and an AutoApply pack costs nothing (no Razorpay order, credited at once).
--   per_job_rupee  : AutoApply only — the pack costs ₹1 per application (50 apps = ₹50), paid via Razorpay.
--
-- Only the server (service role) reads or writes these tables: RLS on, no policies, no grants to anon/authenticated.
-- Create a coupon (SQL editor):
--   INSERT INTO public.coupons (code, kind, max_uses, per_user_limit, expires_at, note)
--   VALUES ('VLOOMFREE', 'free_all', 20, 1, now() + interval '30 days', 'friends & testers');

CREATE TABLE IF NOT EXISTS public.coupons (
  code            text PRIMARY KEY CHECK (code = upper(code) AND code ~ '^[A-Z0-9_-]{3,40}$'),
  kind            text NOT NULL CHECK (kind IN ('free_all', 'per_job_rupee')),
  active          boolean NOT NULL DEFAULT true,
  max_uses        integer CHECK (max_uses IS NULL OR max_uses >= 0),   -- all users together; NULL = unlimited
  uses            integer NOT NULL DEFAULT 0,
  per_user_limit  integer DEFAULT 1 CHECK (per_user_limit IS NULL OR per_user_limit >= 0), -- per user, per target
  plan            text NOT NULL DEFAULT 'max' CHECK (plan IN ('pro', 'max')),            -- plan a free_all grants
  expires_at      timestamptz,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.coupon_redemptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL REFERENCES public.coupons(code) ON UPDATE CASCADE,
  user_id     uuid NOT NULL,
  target      text NOT NULL CHECK (target IN ('plan', 'autoapply')),
  batch_id    uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_coupon_redemptions_user ON public.coupon_redemptions (code, user_id, target);

ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupon_redemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coupons, public.coupon_redemptions FROM anon, authenticated;

ALTER TABLE public.aa_batches ADD COLUMN IF NOT EXISTS coupon_code text;
ALTER TABLE public.aa_batches ADD COLUMN IF NOT EXISTS coupon_redemption_id uuid;

-- Check (p_dry) or redeem a coupon. Raises coupon_invalid | coupon_not_applicable | coupon_used_up |
-- coupon_already_used. The row lock makes the global and per-user limits safe under concurrent checkouts.
CREATE OR REPLACE FUNCTION public.redeem_coupon(p_code text, p_user uuid, p_target text, p_dry boolean DEFAULT false)
RETURNS TABLE (redemption_id uuid, kind text, plan text)
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
    SELECT count(*) INTO n FROM public.coupon_redemptions r
     WHERE r.code = c.code AND r.user_id = p_user AND r.target = p_target;
    IF n >= c.per_user_limit THEN RAISE EXCEPTION 'coupon_already_used'; END IF;
  END IF;
  IF NOT p_dry THEN
    UPDATE public.coupons SET uses = uses + 1 WHERE code = c.code;
    INSERT INTO public.coupon_redemptions (code, user_id, target) VALUES (c.code, p_user, p_target) RETURNING id INTO rid;
  END IF;
  RETURN QUERY SELECT rid, c.kind, c.plan;
END $$;

-- Give a redemption back (checkout failed / pending order expired unpaid).
CREATE OR REPLACE FUNCTION public.release_coupon(p_redemption uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c text;
BEGIN
  DELETE FROM public.coupon_redemptions WHERE id = p_redemption RETURNING code INTO c;
  IF c IS NOT NULL THEN UPDATE public.coupons SET uses = greatest(uses - 1, 0) WHERE code = c; END IF;
END $$;

REVOKE EXECUTE ON FUNCTION public.redeem_coupon(text, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_coupon(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_coupon(text, uuid, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_coupon(uuid) TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.coupons, public.coupon_redemptions TO service_role;

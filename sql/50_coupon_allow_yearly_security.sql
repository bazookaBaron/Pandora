-- 50_coupon_allow_yearly_security.sql
-- Plan coupons grant ONE MONTH (30 days) by default. A coupon may grant a yearly term only when
-- this flag is explicitly set. The API treats a missing column / NULL as false.
ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS allow_yearly boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.coupons.allow_yearly IS 'When true a free_all plan coupon may be redeemed for a 365-day term (client billingPeriod=yearly). Default false: coupons always grant monthly.';

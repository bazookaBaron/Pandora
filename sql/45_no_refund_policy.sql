-- 45_no_refund_policy.sql — owner policy: a bought AutoApply batch is NEVER refunded automatically.
-- "Complete all jobs; increase days or anything; all numbers must be delivered."
--
--  1. aa_batches gains
--       refund_reason          payment-safety refund marker set by orders.js markBatchPaid (late payment after the
--                              order was cancelled, monthly-cap overflow at capture, coupon gone at capture);
--       refund_approved_at/by  a manual admin refund (payment error / legal): POST /api/autoapply/admin/batches/:id/refund;
--       needs_you_notified_at  the ONE "a few details needed" push per batch (lib/autoapply/needsYouForm.js).
--  2. Guard trigger: an UPDATE that moves a batch into 'refund_due' without refund_approved_at or a payment-safety
--     refund_reason is rewritten (status kept / 'paused' for a closed one / 'completed' when nothing is left),
--     an unfulfilled batch is never set 'expired', and an open batch with credits left whose expires_at is within
--     3 days gets now() + 7 days. This covers the Python scheduler's legacy expiry path too.
--  3. aa_payment_reviews: payments a human must look at (webhook amount mismatch, ...). Service role only.
--  4. Legacy parked cancel requests are dropped (the batch stays paused, resumable).

ALTER TABLE public.aa_batches ADD COLUMN IF NOT EXISTS refund_reason text;
ALTER TABLE public.aa_batches ADD COLUMN IF NOT EXISTS refund_approved_at timestamptz;
ALTER TABLE public.aa_batches ADD COLUMN IF NOT EXISTS refund_approved_by uuid;
ALTER TABLE public.aa_batches ADD COLUMN IF NOT EXISTS needs_you_notified_at timestamptz;

CREATE OR REPLACE FUNCTION public.aa_batches_refund_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  open_states text[] := ARRAY['paid','shortlisting','review','running','paused','waiting_supply','waiting_profile'];
BEGIN
  IF NEW.status = 'refund_due' AND OLD.status IS DISTINCT FROM 'refund_due' AND OLD.status IS DISTINCT FROM 'refunding'
     AND NEW.refund_approved_at IS NULL
     AND COALESCE(NEW.refund_reason, '') NOT IN ('late_payment_auto_refund','monthly_cap_auto_refund','coupon_unavailable_auto_refund') THEN
    IF COALESCE(NEW.credits_used, 0) >= COALESCE(NEW.credits_total, 0) THEN
      NEW.status := 'completed';
    ELSIF OLD.status = ANY (open_states) THEN
      NEW.status := OLD.status;
    ELSE
      NEW.status := 'paused';
    END IF;
  END IF;
  IF NEW.status = 'expired' AND OLD.status IS DISTINCT FROM 'expired'
     AND COALESCE(NEW.credits_used, 0) < COALESCE(NEW.credits_total, 0) THEN
    NEW.status := CASE WHEN OLD.status = ANY (open_states) THEN OLD.status ELSE 'paused' END;
  END IF;
  IF NEW.status = ANY (open_states) AND COALESCE(NEW.credits_used, 0) < COALESCE(NEW.credits_total, 0)
     AND NEW.expires_at IS NOT NULL AND NEW.expires_at < now() + interval '3 days' THEN
    NEW.expires_at := now() + interval '7 days';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_aa_batches_refund_guard ON public.aa_batches;
CREATE TRIGGER trg_aa_batches_refund_guard BEFORE UPDATE ON public.aa_batches
  FOR EACH ROW EXECUTE FUNCTION public.aa_batches_refund_guard();
REVOKE EXECUTE ON FUNCTION public.aa_batches_refund_guard() FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.aa_payment_reviews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL CHECK (kind IN ('amount_mismatch','second_payment','other')),
  batch_id            uuid REFERENCES public.aa_batches(id) ON DELETE SET NULL,
  user_id             uuid,
  razorpay_order_id   text,
  razorpay_payment_id text NOT NULL,
  expected_paise      integer,
  paid_paise          integer,
  detail              jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_at         timestamptz,
  resolution_note     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (razorpay_payment_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_aa_payment_reviews_open ON public.aa_payment_reviews (created_at) WHERE resolved_at IS NULL;
ALTER TABLE public.aa_payment_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.aa_payment_reviews FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.aa_payment_reviews TO service_role;

UPDATE public.aa_batches SET cancel_requested_at = NULL WHERE status = 'paused' AND cancel_requested_at IS NOT NULL;
UPDATE public.aa_batches SET expires_at = now() + interval '7 days'
 WHERE status IN ('paid','shortlisting','review','running','paused','waiting_supply','waiting_profile')
   AND credits_used < credits_total AND expires_at IS NOT NULL AND expires_at < now() + interval '3 days';

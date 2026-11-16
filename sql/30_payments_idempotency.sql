-- ============================================================================
-- 30_payments_idempotency.sql
-- Exactly-once payment grants + webhook de-duplication.
--   * processed_payments : one row per captured Razorpay payment. UNIQUE on
--     payment_id AND order_id, so the verify route and the order.paid webhook
--     can race but only ONE of them extends the user's term.
--   * processed_webhook_events : one row per x-razorpay-event-id.
-- Server (service_role) only. Idempotent. Run AFTER 06 + 16.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.processed_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id      text NOT NULL,
  order_id        text NOT NULL,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan            text NOT NULL,
  billing_period  text NOT NULL,
  amount          integer,
  currency        text,
  source          text NOT NULL DEFAULT 'verify',   -- verify | webhook
  period_end      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT processed_payments_payment_uniq UNIQUE (payment_id),
  CONSTRAINT processed_payments_order_uniq   UNIQUE (order_id)
);
CREATE INDEX IF NOT EXISTS idx_processed_payments_user ON public.processed_payments (user_id);

CREATE TABLE IF NOT EXISTS public.processed_webhook_events (
  event_id    text PRIMARY KEY,
  event_type  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_processed_webhook_events_created ON public.processed_webhook_events (created_at);

ALTER TABLE public.processed_payments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processed_webhook_events ENABLE ROW LEVEL SECURITY;
-- No policies => anon/authenticated cannot read or write. service_role bypasses RLS.
REVOKE ALL ON public.processed_payments       FROM anon, authenticated;
REVOKE ALL ON public.processed_webhook_events FROM anon, authenticated;
GRANT ALL ON public.processed_payments       TO service_role;
GRANT ALL ON public.processed_webhook_events TO service_role;

-- Optional housekeeping (cron):
--   DELETE FROM public.processed_webhook_events WHERE created_at < now() - interval '60 days';

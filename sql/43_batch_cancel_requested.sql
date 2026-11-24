-- 43_batch_cancel_requested.sql — cancel while tasks are in flight.
-- The cancel route (routes/autoapply.js) no longer flips a batch with in-flight tasks
-- (claimed/running/waiting_code/submitting) straight to refund_due: it parks it as 'paused' with
-- cancel_requested_at, and the Pandora refunds cron (lib/autoapply/refunds.js finalizeCancelRequests) moves it
-- to refund_due / completed once nothing is in flight. Resume is refused while cancel_requested_at is set.
ALTER TABLE public.aa_batches ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
CREATE INDEX IF NOT EXISTS ix_aa_batches_cancel_requested
  ON public.aa_batches (status) WHERE cancel_requested_at IS NOT NULL;

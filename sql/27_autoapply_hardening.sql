-- ============================================================================
-- 27_autoapply_hardening.sql — AutoApply audit fixes (MAIN Vloombox project).
-- Apply AFTER sql/26. Idempotent (safe to re-run).
--
--  1. aa_batches.status gains 'refunding': the refunds cron (lib/autoapply/refunds.js) claims a 'refund_due'
--     batch with UPDATE ... SET status = 'refunding' WHERE id = $1 AND status = 'refund_due' RETURNING *, so only
--     one API replica refunds it. A claim older than 30 min (crashed replica) is re-claimed; that is safe because
--     an existing Razorpay refund for the batch is detected and reused before a new one is created.
--  2. aa_credit_ledger.note: why a ledger row exists when it is not the usual flow
--     ('late_payment_auto_refund', 'monthly_cap_auto_refund').
--  3. Indexes: active tasks per tenant, applied tasks per user + company, needs-you by task, ledger by batch +
--     reason, trigram search on open job company names (companies/suggest), pending order expiry.
-- ============================================================================

-- 1. 'refunding' status ---------------------------------------------------------
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.aa_batches'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%pending_payment%'
  LOOP
    EXECUTE format('ALTER TABLE public.aa_batches DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.aa_batches
  ADD CONSTRAINT aa_batches_status_check CHECK (status IN (
    'pending_payment','paid','shortlisting','review','running','paused',
    'waiting_supply','waiting_profile','completed','expired','refund_due','refunding','refunded','cancelled'));

-- 2. ledger note ------------------------------------------------------------------
ALTER TABLE public.aa_credit_ledger ADD COLUMN IF NOT EXISTS note text;

-- 3. indexes ------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_aa_tasks_tenant_active ON public.aa_tasks (tenant_host)
  WHERE status IN ('claimed','running','waiting_code','submitting');
CREATE INDEX IF NOT EXISTS idx_aa_tasks_user_company_applied ON public.aa_tasks (user_id, company_key, submitted_at)
  WHERE status = 'applied';
CREATE INDEX IF NOT EXISTS idx_aa_needs_you_task ON public.aa_needs_you (task_id);
CREATE INDEX IF NOT EXISTS idx_aa_ledger_batch_reason ON public.aa_credit_ledger (batch_id, reason);
CREATE INDEX IF NOT EXISTS idx_aa_batches_pending_created ON public.aa_batches (created_at)
  WHERE status = 'pending_payment';
CREATE INDEX IF NOT EXISTS idx_aa_batches_refund_claim ON public.aa_batches (updated_at)
  WHERE status IN ('refund_due','refunding');

-- trigram index for ILIKE '%term%' on open jobs' company names. On Supabase pg_trgm lives in schema
-- 'extensions'; elsewhere it may be in 'public' — the operator class is qualified with whichever schema has it.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
DO $$
DECLARE s text;
BEGIN
  SELECT n.nspname INTO s FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm';
  IF s IS NOT NULL AND to_regclass('public.idx_aa_jobs_company_trgm') IS NULL THEN
    EXECUTE format('CREATE INDEX idx_aa_jobs_company_trgm ON public.aa_jobs USING gin (company %I.gin_trgm_ops) WHERE closed_at IS NULL', s);
  END IF;
END $$;

-- 4. main-db fallback copy of aa_mail_events (used only while AA_MAIL_SUPABASE_URL is unset): same auth_ok flag
--    and retention as sql/mail/05.
DO $$
BEGIN
  IF to_regclass('public.aa_mail_events') IS NOT NULL THEN
    ALTER TABLE public.aa_mail_events ADD COLUMN IF NOT EXISTS auth_ok boolean;
    UPDATE public.aa_mail_events SET expires_at = received_at + interval '7 days'
     WHERE category = 'code' AND user_id IS NOT NULL AND expires_at IS NULL;
    UPDATE public.aa_mail_events SET expires_at = received_at + interval '3 days'
     WHERE user_id IS NULL AND (expires_at IS NULL OR expires_at > received_at + interval '3 days');
  END IF;
END $$;

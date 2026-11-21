-- ============================================================================
-- AutoApply MAIL database, migration 04 (apply to the SEPARATE mail project, after 03). Idempotent.
-- aa_interviews lives in the mail db (sql/mail/02). The MAIN-db copy (sql/23, used only while the separate mail
-- project is not configured) gets the same columns in sql/26_interview_reminders.sql.
--
-- Interview reminders (lib/autoapply/reminders.js, cron every 5 min in server.js): a web push 24 h and 1 h before
-- starts_at. A reminder is claimed with UPDATE ... SET reminder_Xh_at = now() WHERE id = $1 AND reminder_Xh_at IS NULL
-- and only the run that won the claim pushes, so a reminder is never sent twice.
-- ============================================================================

ALTER TABLE public.aa_interviews ADD COLUMN IF NOT EXISTS reminder_24h_at timestamptz;   -- 24 h reminder sent (or skipped: missed slot)
ALTER TABLE public.aa_interviews ADD COLUMN IF NOT EXISTS reminder_1h_at  timestamptz;   -- 1 h reminder sent

-- the cron scans interviews starting within the next 24 h that still owe a reminder
CREATE INDEX IF NOT EXISTS idx_aa_interviews_reminder_due ON public.aa_interviews (starts_at)
  WHERE starts_at IS NOT NULL AND reminder_1h_at IS NULL;

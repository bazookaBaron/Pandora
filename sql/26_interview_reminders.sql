-- 26_interview_reminders.sql — AutoApply interview reminder bookkeeping (MAIN Vloombox project).
-- Apply AFTER sql/25. Idempotent.
--
-- NOTE: in production aa_interviews lives in the SEPARATE mail project; apply sql/mail/04_interview_reminders.sql
-- there. This file covers the main-db copy of aa_interviews (sql/23), which the API uses only while
-- AA_MAIL_SUPABASE_URL / AA_MAIL_SUPABASE_SERVICE_ROLE_KEY are unset. Both files add the same columns.
--
-- Interview reminders (lib/autoapply/reminders.js, cron every 5 min in server.js): a web push 24 h and 1 h before
-- starts_at. A reminder is claimed with UPDATE ... SET reminder_Xh_at = now() WHERE id = $1 AND reminder_Xh_at IS NULL
-- and only the run that won the claim pushes, so a reminder is never sent twice.

ALTER TABLE public.aa_interviews ADD COLUMN IF NOT EXISTS reminder_24h_at timestamptz;   -- 24 h reminder sent (or skipped: missed slot)
ALTER TABLE public.aa_interviews ADD COLUMN IF NOT EXISTS reminder_1h_at  timestamptz;   -- 1 h reminder sent

CREATE INDEX IF NOT EXISTS idx_aa_interviews_reminder_due ON public.aa_interviews (starts_at)
  WHERE starts_at IS NOT NULL AND reminder_1h_at IS NULL;

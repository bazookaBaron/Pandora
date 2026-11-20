-- 22_autoapply_gate.sql — AutoApply profile-complete gate (MAIN Vloombox project).
-- Apply AFTER sql/20_autoapply.sql. Idempotent: safe to run more than once.
--
-- A paid batch is not shortlisted, and no task of it is claimed, until the user's details are complete
-- (cloud_hunter/saas/profile_gate.py: name, email, phone, location, current company / title, experience,
-- education, a resume file and every required onboarding question). Such a batch waits in the new status
-- 'waiting_profile' with the missing items in aa_batches.waiting_detail, and the user gets ONE open needs-you
-- item of kind 'profile' (no task: task_id NULL, batch_id set) listing them. The scheduler moves the batch on
-- (and resolves the item as 'done_by_user') on its next pass after the profile is complete.

-- 1. batch status 'waiting_profile'
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
    'waiting_supply','waiting_profile','completed','expired','refund_due','refunded','cancelled'));

-- {"reason": "profile_incomplete", "missing": [{"key": "resume", "label": "Upload your resume"}, ...],
--  "checked_at": "..."}; NULL when the batch is not held
ALTER TABLE public.aa_batches ADD COLUMN IF NOT EXISTS waiting_detail jsonb;

-- 2. needs-you items without a task (kind 'profile')
ALTER TABLE public.aa_needs_you ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE public.aa_needs_you
  ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES public.aa_batches(id) ON DELETE CASCADE;

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.aa_needs_you'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%captcha%'
  LOOP
    EXECUTE format('ALTER TABLE public.aa_needs_you DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.aa_needs_you
  ADD CONSTRAINT aa_needs_you_kind_check CHECK (kind IN ('captcha','question','sso','account','other','profile'));

ALTER TABLE public.aa_needs_you DROP CONSTRAINT IF EXISTS aa_needs_you_task_or_profile;
ALTER TABLE public.aa_needs_you
  ADD CONSTRAINT aa_needs_you_task_or_profile CHECK (task_id IS NOT NULL OR kind = 'profile');

-- one open profile item per user (the scheduler / worker upsert it)
CREATE UNIQUE INDEX IF NOT EXISTS uq_aa_needs_you_profile_open
  ON public.aa_needs_you (user_id) WHERE kind = 'profile' AND resolved_at IS NULL;

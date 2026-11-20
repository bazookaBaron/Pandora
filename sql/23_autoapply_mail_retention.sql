-- ============================================================================
-- AutoApply mail retention + interviews (MAIN Vloombox project). Apply AFTER sql/21_autoapply_inbox.sql.
-- Idempotent.
--
-- Only needed for FALLBACK mode (AA_MAIL_SUPABASE_URL unset, so the API keeps mail in THIS project's
-- aa_mail_events). It mirrors sql/mail/02_mail_retention_interviews.sql: harmless once the separate mail
-- project is in use. Retention rule: only 'received' and 'rejected' mail is deleted, 30 days after receipt;
-- every other mail keeps expires_at NULL (never deleted).
-- ============================================================================

ALTER TABLE public.aa_mail_events DROP CONSTRAINT IF EXISTS aa_mail_events_category_check;
ALTER TABLE public.aa_mail_events
  ADD CONSTRAINT aa_mail_events_category_check CHECK (category IN ('code','received','rejected','important','other'));

ALTER TABLE public.aa_mail_events ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE public.aa_mail_events ALTER COLUMN expires_at DROP DEFAULT;     -- sql/21 defaulted to now() + 180 days

ALTER TABLE public.aa_mail_events ADD COLUMN IF NOT EXISTS kind      text;
ALTER TABLE public.aa_mail_events ADD COLUMN IF NOT EXISTS company   text;
ALTER TABLE public.aa_mail_events ADD COLUMN IF NOT EXISTS from_name text;
ALTER TABLE public.aa_mail_events ADD COLUMN IF NOT EXISTS read_at   timestamptz;
ALTER TABLE public.aa_mail_events DROP CONSTRAINT IF EXISTS aa_mail_events_kind_check;
ALTER TABLE public.aa_mail_events
  ADD CONSTRAINT aa_mail_events_kind_check CHECK (kind IS NULL OR kind IN ('interview','assessment','offer','recruiter','rejection'));

UPDATE public.aa_mail_events SET expires_at = NULL
 WHERE category IN ('code','important','other') AND expires_at IS NOT NULL;
UPDATE public.aa_mail_events SET expires_at = received_at + interval '30 days'
 WHERE category IN ('received','rejected') AND (expires_at IS NULL OR expires_at <> received_at + interval '30 days');
UPDATE public.aa_mail_events SET read_at = now()
 WHERE read_at IS NULL AND NOT (category = 'important' AND received_at > now() - interval '7 days');

CREATE INDEX IF NOT EXISTS idx_aa_mail_expires_due ON public.aa_mail_events (expires_at)
  WHERE expires_at IS NOT NULL AND category IN ('received','rejected');
CREATE INDEX IF NOT EXISTS idx_aa_mail_unread ON public.aa_mail_events (user_id)
  WHERE read_at IS NULL AND category IN ('important','rejected');
CREATE INDEX IF NOT EXISTS idx_aa_mail_user_kind ON public.aa_mail_events (user_id, kind, received_at DESC);

CREATE TABLE IF NOT EXISTS public.aa_interviews (
  id                bigserial PRIMARY KEY,
  mail_event_id     bigint NOT NULL UNIQUE REFERENCES public.aa_mail_events(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company           text,
  role              text,
  starts_at         timestamptz,
  ends_at           timestamptz,
  timezone          text,
  tz_assumed        boolean NOT NULL DEFAULT false,
  time_text         text,
  duration_min      integer,
  meeting_url       text,
  meeting_provider  text,
  schedule_url      text,
  location          text,
  mode              text,
  round             text,
  interview_type    text,
  source            text NOT NULL DEFAULT 'text',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aa_interviews_user_start   ON public.aa_interviews (user_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_aa_interviews_user_created ON public.aa_interviews (user_id, created_at DESC);
ALTER TABLE public.aa_interviews ENABLE ROW LEVEL SECURITY;
-- No client policies: the API (service role) serves interviews to the owner.

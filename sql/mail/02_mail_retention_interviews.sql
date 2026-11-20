-- ============================================================================
-- AutoApply MAIL database, migration 02 (apply to the SEPARATE mail project, after 01_mail_db.sql).
-- Idempotent. Apply BEFORE deploying the API that writes kind / company / from_name / read_at.
--
-- Retention change (owner rule): ONLY 'received' ("application received / applied successfully") and the new
-- 'rejected' category are deleted, 30 days after receipt. Everything else (codes, interviews, assessments,
-- offers, recruiter mail, other) is never deleted: expires_at IS NULL. The daily cleanup in the API
-- (lib/autoapply/mailJobs.js cleanupExpiredMail) deletes only category IN ('received','rejected') AND
-- expires_at < now(); NULL never matches.
--
-- Also: kind (interview | assessment | offer | recruiter | rejection), company, from_name, read_at (unread
-- badge), and aa_interviews (structured interview details extracted from mail).
-- ============================================================================

-- 1. 'rejected' category
ALTER TABLE public.aa_mail_events DROP CONSTRAINT IF EXISTS aa_mail_events_category_check;
ALTER TABLE public.aa_mail_events
  ADD CONSTRAINT aa_mail_events_category_check CHECK (category IN ('code','received','rejected','important','other'));

-- 2. non-expiring mail: expires_at NULL = never deleted
ALTER TABLE public.aa_mail_events ALTER COLUMN expires_at DROP NOT NULL;

-- 3. new columns
ALTER TABLE public.aa_mail_events ADD COLUMN IF NOT EXISTS kind      text;
ALTER TABLE public.aa_mail_events ADD COLUMN IF NOT EXISTS company   text;
ALTER TABLE public.aa_mail_events ADD COLUMN IF NOT EXISTS from_name text;
ALTER TABLE public.aa_mail_events ADD COLUMN IF NOT EXISTS read_at   timestamptz;
ALTER TABLE public.aa_mail_events DROP CONSTRAINT IF EXISTS aa_mail_events_kind_check;
ALTER TABLE public.aa_mail_events
  ADD CONSTRAINT aa_mail_events_kind_check CHECK (kind IS NULL OR kind IN ('interview','assessment','offer','recruiter','rejection'));

-- 4. backfill expiry: codes / important / other are no longer scheduled for deletion; receipts get 30 days
--    from receipt. (Rejections hidden inside old 'received' / 'important' rows are found by the one-off
--    script frontend/scripts/aa-mail-backfill.mjs, which also fills kind / company and aa_interviews.)
UPDATE public.aa_mail_events SET expires_at = NULL
 WHERE category IN ('code','important','other') AND expires_at IS NOT NULL;
UPDATE public.aa_mail_events SET expires_at = received_at + interval '30 days'
 WHERE category IN ('received','rejected') AND (expires_at IS NULL OR expires_at <> received_at + interval '30 days');

-- 5. existing mail starts as read (the badge counts only what arrives from now on), except recent important mail
UPDATE public.aa_mail_events SET read_at = now()
 WHERE read_at IS NULL AND NOT (category = 'important' AND received_at > now() - interval '7 days');

-- 6. indexes
DROP INDEX IF EXISTS public.idx_aa_mail_expires;
CREATE INDEX IF NOT EXISTS idx_aa_mail_expires_due ON public.aa_mail_events (expires_at)
  WHERE expires_at IS NOT NULL AND category IN ('received','rejected');
DROP INDEX IF EXISTS public.idx_aa_mail_alert_due;
CREATE INDEX IF NOT EXISTS idx_aa_mail_alert_due ON public.aa_mail_events (received_at)
  WHERE category IN ('important','rejected') AND alerted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_aa_mail_unread ON public.aa_mail_events (user_id)
  WHERE read_at IS NULL AND category IN ('important','rejected');
CREATE INDEX IF NOT EXISTS idx_aa_mail_user_kind    ON public.aa_mail_events (user_id, kind, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_aa_mail_user_company ON public.aa_mail_events (user_id, company);

-- 7. interviews extracted from mail (one per mail; deleted with its mail, which is never deleted for interviews)
CREATE TABLE IF NOT EXISTS public.aa_interviews (
  id                bigserial PRIMARY KEY,
  mail_event_id     bigint NOT NULL UNIQUE REFERENCES public.aa_mail_events(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL,                          -- main project's auth user (no FK across projects)
  company           text,
  role              text,
  starts_at         timestamptz,                            -- NULL = no time in the mail yet (e.g. "pick a slot")
  ends_at           timestamptz,
  timezone          text,                                   -- as named in the mail / invite (IST, GMT+05:30, Asia/Kolkata)
  tz_assumed        boolean NOT NULL DEFAULT false,         -- true: no zone in the mail, read as India time
  time_text         text,                                   -- the date/time text as written
  duration_min      integer,
  meeting_url       text,
  meeting_provider  text,                                   -- zoom | google_meet | teams | webex | chime | skype | hirevue
  schedule_url      text,                                   -- Calendly / GoodTime / ATS scheduling link
  location          text,
  mode              text,                                   -- video | phone | onsite
  round             text,                                   -- "Round 2", "Final round"
  interview_type    text,                                   -- technical | coding | system_design | hiring_manager | behavioral | hr | recruiter_screen | panel
  source            text NOT NULL DEFAULT 'text',           -- ics | text
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aa_interviews_user_start ON public.aa_interviews (user_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_aa_interviews_user_created ON public.aa_interviews (user_id, created_at DESC);

ALTER TABLE public.aa_interviews ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: only the service role (API) reads or writes.

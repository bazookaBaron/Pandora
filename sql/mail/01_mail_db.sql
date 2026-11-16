-- ============================================================================
-- AutoApply MAIL database (a SEPARATE free-tier Supabase project, 500 MB).
-- Apply this ONLY to the new mail project, never to the main Vloombox project.
--
-- Why separate: customer mail is bulky and short-lived; keeping it out of the main
-- database keeps the main DB small. Mail is never forwarded anywhere; it is read
-- only inside Vloombox (inbox page) and expires by category (daily cleanup cron
-- in the API: code 1 d, received 14 d, important/other 180 d).
--
-- Access: the Express API (service role, env AA_MAIL_SUPABASE_URL +
-- AA_MAIL_SUPABASE_SERVICE_ROLE_KEY) and the Python bot (direct Postgres,
-- AA_MAIL_DB_URL, port 5432, LISTEN aa_mail). Browsers never touch this project:
-- RLS is on with NO client policies. user_id is a uuid from the MAIN project's
-- auth.users; there is deliberately no foreign key.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.aa_mail_events (
  id                bigserial PRIMARY KEY,
  user_id           uuid,                                   -- main project's auth user; NULL = unknown alias
  alias             text NOT NULL,                          -- full local part the mail was sent to
  sender            text NOT NULL,
  subject           text,
  codes             text[] NOT NULL DEFAULT '{}',
  links             text[] NOT NULL DEFAULT '{}',
  is_human          boolean NOT NULL DEFAULT false,
  text_excerpt      text,
  raw_ref           text,                                   -- R2 key (optional archive)
  received_at       timestamptz NOT NULL DEFAULT now(),
  consumed_by_task  uuid,
  forwarded_at      timestamptz,                            -- legacy, never set any more (mail is not forwarded)
  category          text NOT NULL CHECK (category IN ('code','received','important','other')),
  has_attachments   boolean NOT NULL DEFAULT false,
  alerted_at        timestamptz,                            -- set when the daily alert email covered this mail
  expires_at        timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_aa_mail_user_recent ON public.aa_mail_events (user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_aa_mail_expires     ON public.aa_mail_events (expires_at);
CREATE INDEX IF NOT EXISTS idx_aa_mail_alert_due   ON public.aa_mail_events (received_at) WHERE category = 'important' AND alerted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_aa_mail_search
  ON public.aa_mail_events
  USING gin (to_tsvector('simple', coalesce(subject, '') || ' ' || coalesce(sender, '') || ' ' || coalesce(text_excerpt, '')));

ALTER TABLE public.aa_mail_events ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: only the service role / direct Postgres connection can read or write.

-- Same pg_notify contract as the main project had: channel aa_mail, payload '<user_id>:<event_id>'.
CREATE OR REPLACE FUNCTION public.aa_notify_mail(p_user uuid, p_event bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT pg_notify('aa_mail', p_user::text || ':' || p_event::text);
$$;
REVOKE ALL ON FUNCTION public.aa_notify_mail(uuid, bigint) FROM PUBLIC, anon, authenticated;

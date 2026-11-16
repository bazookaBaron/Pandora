-- ============================================================================
-- AutoApply inbox, alerts (MAIN Vloombox project). Apply AFTER sql/20_autoapply.sql
-- and BEFORE deploying the API that uses it. Idempotent.
-- The mail itself lives in the separate mail project: sql/mail/01_mail_db.sql.
-- ============================================================================

-- Web push subscriptions (one row per browser/device).
CREATE TABLE IF NOT EXISTS public.aa_push_subscriptions (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aa_push_user ON public.aa_push_subscriptions (user_id);

ALTER TABLE public.aa_push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aa_push_select_own ON public.aa_push_subscriptions;
CREATE POLICY aa_push_select_own ON public.aa_push_subscriptions
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- Alert preferences: {"email": true, "push": true}
ALTER TABLE public.aa_profiles
  ADD COLUMN IF NOT EXISTS alert_prefs jsonb NOT NULL DEFAULT '{"email":true,"push":true}'::jsonb;

-- Fallback mode only: while AA_MAIL_SUPABASE_URL is unset the API stores mail in THIS project's
-- aa_mail_events, so give that table the new columns (defaults keep old rows valid). Harmless once the
-- separate mail project is in use; the old table can then be dropped.
ALTER TABLE public.aa_mail_events ADD COLUMN IF NOT EXISTS category        text NOT NULL DEFAULT 'other';
ALTER TABLE public.aa_mail_events ADD COLUMN IF NOT EXISTS has_attachments boolean NOT NULL DEFAULT false;
ALTER TABLE public.aa_mail_events ADD COLUMN IF NOT EXISTS alerted_at      timestamptz;
ALTER TABLE public.aa_mail_events ADD COLUMN IF NOT EXISTS expires_at      timestamptz NOT NULL DEFAULT (now() + interval '180 days');

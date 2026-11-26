-- ============================================================================
-- 48_ui_events.sql   (NOT applied yet; idempotent, safe to re-run)
--
-- First-party funnel events for the mobile-first redesign (WS-M0).
-- Written only by frontend/server.js POST /api/events through the service-role
-- client (src/lib/track.js sends them). Allowed events (validated server-side):
--   tab_view, cta_click, setup_step, buy_view, pay_start, pay_success, bridge_click, first_visit_pick
--
-- Privacy: no personal data. user_id is set only from a verified bearer token
-- (signed-in users); anon_id is a random per-browser id; props is a small flat
-- object (<= 1 KB, server-filtered) of ids / counts, never names, emails or text.
--
-- Access: RLS enabled with NO policies, so anon / authenticated get nothing;
-- only the service role (which bypasses RLS) reads or writes.
--
-- Retention: 90 days. public.ui_events_retention() deletes older rows; it gets its
-- own daily pg_cron job (03:40 UTC, right after pandora-retention-daily at 03:30)
-- instead of editing public.run_retention() from 44_retention_and_bloat.sql.
--
-- Weekly funnel numbers (plan section 6), for example:
--   SELECT event, count(*), count(DISTINCT coalesce(user_id::text, anon_id))
--     FROM public.ui_events WHERE at > now() - interval '7 days' GROUP BY 1 ORDER BY 1;
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ui_events (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  event    text NOT NULL,
  path     text,
  section  text,
  user_id  uuid NULL,
  anon_id  text,
  props    jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT ui_events_event_chk CHECK (event IN (
    'tab_view', 'cta_click', 'setup_step', 'buy_view', 'pay_start', 'pay_success', 'bridge_click', 'first_visit_pick'
  )),
  CONSTRAINT ui_events_path_len CHECK (path IS NULL OR length(path) <= 200),
  CONSTRAINT ui_events_section_chk CHECK (section IS NULL OR section IN ('jobs', 'prepare', 'autoapply', 'referrals', 'me')),
  CONSTRAINT ui_events_anon_len CHECK (anon_id IS NULL OR length(anon_id) <= 40),
  CONSTRAINT ui_events_props_size CHECK (pg_column_size(props) <= 2048)
);

COMMENT ON TABLE public.ui_events IS
  'First-party funnel events (WS-M0). Service role only (RLS on, no policies). 90-day retention via ui_events_retention().';

CREATE INDEX IF NOT EXISTS ui_events_event_at_idx ON public.ui_events (event, at);

ALTER TABLE public.ui_events ENABLE ROW LEVEL SECURITY;
-- no policies on purpose: anon / authenticated cannot read or write
REVOKE ALL ON TABLE public.ui_events FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.ui_events FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON SEQUENCE public.ui_events_id_seq FROM anon, authenticated';
  END IF;
END $$;

-- 90-day retention
CREATE OR REPLACE FUNCTION public.ui_events_retention()
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  n int := 0;
BEGIN
  DELETE FROM public.ui_events WHERE at < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.ui_events_retention() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.ui_events_retention() FROM anon, authenticated';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- cron.schedule with a name replaces an existing job of that name
    PERFORM cron.schedule('ui-events-retention-daily', '40 3 * * *', 'SELECT public.ui_events_retention()');
  END IF;
END $$;

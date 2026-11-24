-- ============================================================================
-- 06_mail_retention_more.sql — MAIL project only (never the main Vloombox / Pandora project). Apply AFTER 05.
-- Idempotent. Run by hand in the mail project's SQL editor (the MCP cannot reach that project).
--
--  1. category 'other' mail is deleted 90 days after arrival. classify.js keeps RETENTION_DAYS.other = null, so the
--     JS cleanup (lib/autoapply/mailJobs.js) never touches these rows and the re-classify pass would reset an
--     expires_at set here; the delete therefore runs in SQL on received_at, independent of expires_at. Rows that an
--     aa_interviews row points at (ON DELETE CASCADE) or that carry a kind (interview / offer / ...) are kept.
--  2. text_excerpt is capped at 2000 characters on INSERT / UPDATE (trigger). The Email Worker and inbound.js
--     already slice to 2000; this is the database-side backstop. Existing longer rows are trimmed once.
--  3. Schedule: pg_cron daily at 03:45 UTC when the extension is enabled on the mail project. Without pg_cron,
--     call `SELECT public.aa_mail_retention_more();` from the Pandora server's daily mail cleanup instead.
-- ============================================================================

-- 2. excerpt cap
CREATE OR REPLACE FUNCTION public.aa_mail_cap_excerpt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.text_excerpt IS NOT NULL AND length(NEW.text_excerpt) > 2000 THEN
    NEW.text_excerpt := left(NEW.text_excerpt, 2000);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_aa_mail_cap_excerpt ON public.aa_mail_events;
CREATE TRIGGER trg_aa_mail_cap_excerpt
  BEFORE INSERT OR UPDATE OF text_excerpt ON public.aa_mail_events
  FOR EACH ROW EXECUTE FUNCTION public.aa_mail_cap_excerpt();

UPDATE public.aa_mail_events SET text_excerpt = left(text_excerpt, 2000)
 WHERE length(text_excerpt) > 2000;

-- 1. 'other' after 90 days
CREATE OR REPLACE FUNCTION public.aa_mail_retention_more()
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE n int := 0;
BEGIN
  DELETE FROM public.aa_mail_events e
   WHERE e.category = 'other'
     AND e.received_at < now() - interval '90 days'
     AND e.kind IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.aa_interviews i WHERE i.mail_event_id = e.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.aa_mail_retention_more() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aa_mail_cap_excerpt() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.aa_mail_retention_more() FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.aa_mail_cap_excerpt() FROM anon, authenticated';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.aa_mail_retention_more() TO service_role;   -- the Pandora daily cleanup calls it

CREATE INDEX IF NOT EXISTS idx_aa_mail_other_received ON public.aa_mail_events (received_at)
  WHERE category = 'other';

-- 3. schedule
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('aa-mail-retention-more', '45 3 * * *', 'SELECT public.aa_mail_retention_more()');
  ELSE
    RAISE NOTICE 'pg_cron not enabled: call SELECT public.aa_mail_retention_more() from the daily mail cleanup';
  END IF;
END $$;

-- one-off now
SELECT public.aa_mail_retention_more() AS other_rows_deleted;

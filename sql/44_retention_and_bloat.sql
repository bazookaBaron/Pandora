-- ============================================================================
-- 42_retention_and_bloat.sql   (applied on Pandora 2026-11-23 via MCP; idempotent, safe to re-run)
--
-- Database size / egress hardening:
--   1. crawler.job_posting: drop never-scanned job_posting_ext_idx and job_posting_last_seen_idx (the index on
--      last_seen_at made every re-crawl touch a non-HOT update, 0.04% HOT), fillfactor 80 so the remaining
--      last_seen_at bumps stay HOT. The JobCrawler schema.sql makes the same change, so `jobs migrate` does not
--      recreate them. The crawler also stops rewriting unchanged rows (PGPIPE_TOUCH_MIN_HOURS, default 12).
--      Kept on purpose (used by frontend/server.js /api/jobs filters): company/location/title trigram indexes,
--      job_posting_open_source_idx (source facet).
--   2. Unused indexes elsewhere (idx_scan = 0 and no code filters on them):
--        idx_iq_raw_fields (interview_questions.raw_fields is only selected/inserted, never filtered)
--        lcp_company_gin   (leetcode_company_problems.company is read whole; company filtering happens in JS)
--      Kept although idx_scan = 0, because code does run the ILIKE they serve (small tables, the planner has
--      preferred a seq scan so far): idx_aa_jobs_company_trgm (routes/autoapply.js company search),
--      idx_lcp_title_trgm + idx_leetcode_company_problems_topics_trgm (server.js DSA search).
--   3. Retention, run daily by pg_cron (03:30 UTC, outside the 07:30-13:15 UTC crawl):
--        aa_tasks: evidence -> '{}' and reason_detail -> NULL for finished tasks untouched for 60 days
--        processed_webhook_events: rows older than 60 days deleted
--        report_weekly.report: only the last 26 ISO weeks kept (the market-report build also prunes)
--   4. Removes the broken pg_cron job `sync-leetcode-every-4-days` (placeholder project URL / token).
--
-- report_daily.report: the JobCrawler market-report workflow now keeps job_state / prev_job_state (~15 MB of
-- zlib blobs) in the GitHub Actions cache; the columns are written as NULL from its next run on.
--
-- VACUUM cannot run inside a migration; these were run separately on 2026-11-23 (and should be run once more
-- after the first market-report run with the new code, to give back the nulled job_state TOAST space):
--   VACUUM (FULL, ANALYZE) crawler.job_posting;
--   VACUUM (FULL, ANALYZE) report_daily.report;
--   VACUUM (FULL, ANALYZE) report_weekly.report;
-- Do not run VACUUM FULL on crawler.job_posting between 07:30 and ~13:15 UTC (crawl-jobs holds it busy).
-- ============================================================================

-- 1 + 2: indexes / fillfactor
DROP INDEX IF EXISTS crawler.job_posting_ext_idx;
DROP INDEX IF EXISTS crawler.job_posting_last_seen_idx;
ALTER TABLE crawler.job_posting SET (fillfactor = 80);
DROP INDEX IF EXISTS public.idx_iq_raw_fields;
DROP INDEX IF EXISTS public.lcp_company_gin;

-- 3: retention function
CREATE OR REPLACE FUNCTION public.run_retention()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  n_tasks int := 0;
  n_webhooks int := 0;
  n_weeks int := 0;
BEGIN
  UPDATE public.aa_tasks
     SET evidence = '{}'::jsonb, reason_detail = NULL
   WHERE status IN ('applied', 'skipped', 'failed', 'cancelled', 'removed')
     AND updated_at < now() - interval '60 days'
     AND (evidence <> '{}'::jsonb OR reason_detail IS NOT NULL);
  GET DIAGNOSTICS n_tasks = ROW_COUNT;

  DELETE FROM public.processed_webhook_events
   WHERE created_at < now() - interval '60 days';
  GET DIAGNOSTICS n_webhooks = ROW_COUNT;

  IF to_regclass('report_weekly.report') IS NOT NULL THEN
    DELETE FROM report_weekly.report
     WHERE week_start < (date_trunc('week', now())::date - 26 * 7);
    GET DIAGNOSTICS n_weeks = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('aa_tasks_pruned', n_tasks, 'webhook_events_deleted', n_webhooks,
                            'weekly_reports_deleted', n_weeks);
END $$;

REVOKE ALL ON FUNCTION public.run_retention() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.run_retention() FROM anon, authenticated';
  END IF;
END $$;

-- 3 + 4: pg_cron
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-leetcode-every-4-days') THEN
      PERFORM cron.unschedule('sync-leetcode-every-4-days');
    END IF;
    -- cron.schedule with a name replaces an existing job of that name
    PERFORM cron.schedule('pandora-retention-daily', '30 3 * * *', 'SELECT public.run_retention()');
  END IF;
END $$;

-- ============================================================================
-- 47_task_retention.sql   (NOT applied yet; idempotent, safe to re-run)
--
-- Owner: "not necessary to keep all this data after 30 days, just keep the necessary".
--
-- Daily task retention for FINISHED batches (status completed / expired / refunded / cancelled; refund_due and
-- refunding are not final yet, every open status is skipped). For aa_tasks rows whose updated_at is older than
-- 30 days:
--   * skipped / failed / cancelled ("not applied": only ever counted, never listed) are slimmed at 30 days and
--     DELETED after 95 days (so broadening up to 90 days can't re-shortlist them; aa_needs_you rows cascade);
--   * removed (the user said no to that job) is slimmed but never deleted: it keeps blocking that job;
--   * applied rows are KEPT (company, title, submitted_at, apply_url, batch_id, user_id, status, ...) but the heavy
--     fields are emptied: evidence -> '{}', confirmation_text / reason_detail / artifacts_prefix -> NULL.
--     The proof screenshot is already removed after 30 days by frontend/lib/autoapply/proofRetention.js, which
--     nulls proof_path when it deletes the object; this function never touches proof_path.
--   * needs_you / in-flight rows are never touched.
--
-- Counts stay right: before the first row of a batch is deleted, the batch's task counts are stored in the new
-- aa_batches.final_counts column (in the same transaction):
--   {"v": 1, "at": <ts>, "status": {"applied": 48, "skipped": 12, ...},
--    "reasons": [{"status": "skipped", "reason_code": "captcha", "n": 3}, ...]}   -- skipped / failed / needs_you
-- GET /api/autoapply/batches/:id merges it back (lib/autoapply/insights.js batchCounts / batchChargeSummary), so the
-- "Not applied" number and the "Not charged" breakdown do not change when the rows go away.
--
-- Batched: one call handles at most p_limit (default 500, max 2000) task rows, picked with FOR UPDATE SKIP LOCKED,
-- so it never waits on, or holds for long, a lock the scheduler / workers need. The API server calls it in a loop
-- once a day (frontend/lib/autoapply/taskRetention.js, cron 04:20 IST in server.js, right after proof retention),
-- each call its own short transaction. p_days can only make the window longer than 30 days, never shorter.
--
-- Note: aa_tasks has UNIQUE (user_id, job_key); keeping rows until 95 days (removed: forever) keeps that guard.
-- ============================================================================

ALTER TABLE public.aa_batches ADD COLUMN IF NOT EXISTS final_counts jsonb;

-- finds the rows due for retention without scanning every applied task ever kept
CREATE INDEX IF NOT EXISTS idx_aa_tasks_retention_due ON public.aa_tasks (updated_at)
  WHERE status IN ('skipped', 'failed', 'removed', 'cancelled')
     OR (status = 'applied' AND (evidence <> '{}'::jsonb OR confirmation_text IS NOT NULL
                                 OR reason_detail IS NOT NULL OR artifacts_prefix IS NOT NULL));

CREATE OR REPLACE FUNCTION public.aa_task_retention(p_limit integer DEFAULT 500, p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  lim      integer := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 2000);
  cutoff   timestamptz := now() - make_interval(days => GREATEST(COALESCE(p_days, 30), 30));
  -- not-applied rows are deleted only after 95 days: they stop the same job being shortlisted again while the
  -- scheduler's broadening (window up to 90 days) can still reach it. 'removed' (the user said no) is never deleted.
  del_cut  timestamptz := now() - interval '95 days';
  ids      uuid[];
  bids     uuid[];
  n_snap   integer := 0;
  n_del    integer := 0;
  n_slim   integer := 0;
BEGIN
  -- candidate rows, oldest first; rows or batches someone else holds are skipped this run
  WITH c AS (
    SELECT t.id, t.batch_id
      FROM public.aa_tasks t
      JOIN public.aa_batches b ON b.id = t.batch_id
     WHERE b.status IN ('completed', 'expired', 'refunded', 'cancelled')
       AND t.updated_at < cutoff
       AND ((t.status IN ('skipped', 'failed', 'cancelled') AND t.updated_at < del_cut)
            OR (t.status IN ('applied', 'skipped', 'failed', 'removed', 'cancelled') AND (t.evidence <> '{}'::jsonb OR t.confirmation_text IS NOT NULL
                                          OR t.reason_detail IS NOT NULL OR t.artifacts_prefix IS NOT NULL)))
     ORDER BY t.updated_at
     LIMIT lim
       FOR UPDATE OF t, b SKIP LOCKED
  )
  SELECT array_agg(c.id), array_agg(DISTINCT c.batch_id) INTO ids, bids FROM c;

  IF ids IS NULL THEN
    RETURN jsonb_build_object('processed', 0, 'snapshots', 0, 'deleted', 0, 'slimmed', 0);
  END IF;

  -- 1. counts first (only once per batch: a finished batch's counts no longer change)
  UPDATE public.aa_batches b
     SET final_counts = jsonb_build_object(
           'v', 1,
           'at', now(),
           'status', COALESCE((SELECT jsonb_object_agg(x.status, x.n)
                                 FROM (SELECT t.status, count(*)::int AS n
                                         FROM public.aa_tasks t
                                        WHERE t.batch_id = b.id
                                        GROUP BY t.status) x), '{}'::jsonb),
           'reasons', COALESCE((SELECT jsonb_agg(jsonb_build_object('status', y.status, 'reason_code', y.reason_code, 'n', y.n))
                                  FROM (SELECT t.status, t.reason_code, count(*)::int AS n
                                          FROM public.aa_tasks t
                                         WHERE t.batch_id = b.id
                                           AND t.status IN ('skipped', 'failed', 'needs_you')
                                         GROUP BY t.status, t.reason_code) y), '[]'::jsonb))
   WHERE b.id = ANY (bids)
     AND b.final_counts IS NULL;
  GET DIAGNOSTICS n_snap = ROW_COUNT;

  -- 2. not applied: delete
  DELETE FROM public.aa_tasks
   WHERE id = ANY (ids)
     AND status IN ('skipped', 'failed', 'cancelled')
     AND updated_at < del_cut;
  GET DIAGNOSTICS n_del = ROW_COUNT;

  -- 3. applied: keep the row, drop the heavy fields (proof_path is proofRetention's job)
  UPDATE public.aa_tasks
     SET evidence = '{}'::jsonb, confirmation_text = NULL, reason_detail = NULL, artifacts_prefix = NULL
   WHERE id = ANY (ids)
     AND status IN ('applied', 'skipped', 'failed', 'removed', 'cancelled');
  GET DIAGNOSTICS n_slim = ROW_COUNT;

  RETURN jsonb_build_object('processed', cardinality(ids), 'snapshots', n_snap, 'deleted', n_del, 'slimmed', n_slim);
END $$;

REVOKE ALL ON FUNCTION public.aa_task_retention(integer, integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.aa_task_retention(integer, integer) FROM anon, authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.aa_task_retention(integer, integer) TO service_role';
  END IF;
END $$;

-- ============================================================================
-- 27b_task_submitting.sql  (already applied to prod; kept for history. Idempotent, safe to re-run)
--
-- Duplicate-application guard of the AutoApply worker (cloud_hunter/saas/worker):
--   * child.py sets aa_tasks.status = 'submitting' and submitting_at = now() right before the final Submit click
--     (claim.MARK_SUBMITTING_SQL). 'submitting' is already allowed by the sql/20 CHECK; only the column is new.
--     Until this file is applied the worker falls back to setting the status only (MARK_SUBMITTING_SQL_OLD).
--   * claim.sweep(): a lease that expires in 'submitting' is NEVER requeued; the task becomes
--     status 'needs_you', reason_code 'verify_submission' plus an aa_needs_you row (kind 'other',
--     payload {apply_url, reason: 'verify_submission', note}). No new status / kind value is needed.
--   * Pandora (UI / API): show these items as "please check whether this application went through"; when the user
--     confirms it was submitted, the API may set the task 'applied' (and capture the credit) - the worker also does
--     that itself when it replays a saved 'applied' result (and then dismisses the item).
-- ============================================================================

ALTER TABLE public.aa_tasks ADD COLUMN IF NOT EXISTS submitting_at timestamptz;

-- the sweeper's scan: expired leases of the in-flight statuses
CREATE INDEX IF NOT EXISTS idx_aa_tasks_lease ON public.aa_tasks (lease_until)
  WHERE status IN ('claimed','running','waiting_code','submitting');

-- open verify items per task (the worker dismisses them when the applied result is recorded)
CREATE INDEX IF NOT EXISTS idx_aa_needs_you_verify ON public.aa_needs_you (task_id)
  WHERE resolved_at IS NULL AND payload->>'reason' = 'verify_submission';

-- sanity: the status CHECK of sql/20 must still allow 'submitting' (raise if someone narrowed it)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.aa_tasks'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%submitting%'
  ) THEN
    RAISE EXCEPTION 'aa_tasks status CHECK no longer allows ''submitting''';
  END IF;
END $$;

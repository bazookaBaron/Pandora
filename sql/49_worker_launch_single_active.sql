-- 49_worker_launch_single_active.sql - at most ONE active Vast worker launch, enforced by the database.
-- The autoscaler (AutoJobApplier saas/control/autoscale.py) already keeps max_instances = 1 in code; this makes a
-- race (two aa-control processes, a retry after a timeout) fail at INSERT instead of renting a second GPU.
-- (true) is a constant expression: every row with an active status maps to the same key, so only one can exist.
-- Run after 41_worker_launches.sql. If it fails with "could not create unique index", more than one launch is
-- currently active: destroy the extras first (UPDATE ... SET status = 'stopped' for the older ones), then re-run.
-- Idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS ux_aa_worker_launches_one_active
  ON public.aa_worker_launches ((true))
  WHERE status IN ('starting', 'running', 'stopping');

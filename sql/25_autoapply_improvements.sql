-- 25_autoapply_improvements.sql — AutoApply: proof of submission, must-apply companies, health heartbeats,
-- "not charged" flag (MAIN Vloombox project).
-- Apply AFTER sql/20 .. sql/24. Idempotent: safe to run more than once.
--
-- WHO WRITES WHAT
--  • Python worker (cloud_hunter/saas/worker): aa_tasks.proof_path / confirmation_text after a live submit
--    (screenshot uploaded to Storage bucket 'aa-proof' at '<user_id>/<task_id>.png'), aa_tasks.not_charged on
--    every result it writes, aa_health row 'worker:<host>'.
--  • Python scheduler (saas/scheduler.py): reads aa_batches.must_companies; aa_health row 'scheduler'.
--  • Python discovery (saas/discovery): aa_health row 'discovery' (status 'error', stats.reason 'zero_jobs' when a
--    run wrote no jobs).
--  • Express server (service role): aa_batches.must_companies (set at batch creation / edit), signed URLs for
--    'aa-proof' objects of the owner.
--  • Browser: SELECT own aa_tasks / aa_batches rows (RLS of sql/20). No access to aa_health or to 'aa-proof'.
--
-- CREDITS: credits are only ever captured for a task that reached 'applied' (aa_credit_ledger reason 'capture',
-- one per task, written by the worker in the same transaction as the 'applied' status). Every other terminal
-- outcome (skipped / failed / needs_you / cancelled / removed: captcha, blocked site, site error, ...) never used a
-- credit; not_charged makes that explicit for the UI. The trigger below keeps it in step with status for every
-- writer (worker, scheduler, API); the worker also sets it itself.

-- ── 1. proof of submission ──────────────────────────────────────────────────
ALTER TABLE public.aa_tasks ADD COLUMN IF NOT EXISTS proof_path text;            -- 'aa-proof' object path
ALTER TABLE public.aa_tasks ADD COLUMN IF NOT EXISTS confirmation_text text;     -- confirmation seen on the page
ALTER TABLE public.aa_tasks DROP CONSTRAINT IF EXISTS aa_tasks_confirmation_text_len;
ALTER TABLE public.aa_tasks
  ADD CONSTRAINT aa_tasks_confirmation_text_len CHECK (confirmation_text IS NULL OR char_length(confirmation_text) <= 500);

INSERT INTO storage.buckets (id, name, public) VALUES ('aa-proof', 'aa-proof', false)
ON CONFLICT (id) DO NOTHING;
-- no storage.objects policies for 'aa-proof': only the service role reads / writes (the API hands out signed URLs)

-- ── 2. not charged ──────────────────────────────────────────────────────────
ALTER TABLE public.aa_tasks ADD COLUMN IF NOT EXISTS not_charged boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.aa_tasks_set_not_charged()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.not_charged := NEW.status IN ('skipped','failed','needs_you','cancelled','removed');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_aa_tasks_not_charged ON public.aa_tasks;
CREATE TRIGGER trg_aa_tasks_not_charged BEFORE INSERT OR UPDATE OF status, not_charged ON public.aa_tasks
  FOR EACH ROW EXECUTE FUNCTION public.aa_tasks_set_not_charged();

-- backfill (no-op on a re-run)
UPDATE public.aa_tasks SET not_charged = true
WHERE status IN ('skipped','failed','needs_you','cancelled','removed') AND NOT not_charged;

-- ── 3. must-apply companies per batch ───────────────────────────────────────
-- display names (e.g. 'Infosys', 'Stripe'); the scheduler shortlists their matching jobs first
ALTER TABLE public.aa_batches ADD COLUMN IF NOT EXISTS must_companies text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.aa_batches DROP CONSTRAINT IF EXISTS aa_batches_must_companies_max;
ALTER TABLE public.aa_batches
  ADD CONSTRAINT aa_batches_must_companies_max CHECK (cardinality(must_companies) <= 10);

-- ── 4. health heartbeats ────────────────────────────────────────────────────
-- component: 'discovery' | 'scheduler' | 'worker:<host>'; stats.interval_s = how often the component beats
-- (python -m saas.health calls a row stale after 2 x interval_s)
CREATE TABLE IF NOT EXISTS public.aa_health (
  component   text PRIMARY KEY,
  last_seen   timestamptz NOT NULL DEFAULT now(),
  status      text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','warn','error')),
  stats       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.aa_health ENABLE ROW LEVEL SECURITY;
-- no policies = no client access (service role / direct Postgres only)
REVOKE ALL ON public.aa_health FROM anon, authenticated;

-- 52_aa_status_counts_security.sql
-- /api/autoapply/batches and /batches/:id counted task statuses in JS over up to 10k rows on every poll.
-- This returns the per-batch status histogram from one GROUP BY. Service-role only (the API already
-- scopes by user; p_user is re-checked here so a batch id from another user yields nothing).
CREATE INDEX IF NOT EXISTS idx_aa_tasks_batch_status ON public.aa_tasks (batch_id, status);

CREATE OR REPLACE FUNCTION public.aa_task_status_counts(p_user uuid, p_batch_ids uuid[])
RETURNS TABLE (batch_id uuid, status text, n bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.batch_id, t.status::text, count(*) AS n
    FROM public.aa_tasks t
   WHERE t.user_id = p_user AND t.batch_id = ANY (p_batch_ids)
   GROUP BY t.batch_id, t.status
$$;

REVOKE EXECUTE ON FUNCTION public.aa_task_status_counts(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aa_task_status_counts(uuid, uuid[]) TO service_role;

/**
 * Task retention (sql/47_task_retention.sql): once a day, for FINISHED batches only, task rows older than 30 days
 * (by updated_at) are trimmed by the aa_task_retention(p_limit, p_days) function:
 *   skipped / failed / removed / cancelled  -> deleted (the batch's counts are stored in aa_batches.final_counts
 *                                              first, in the same transaction, so "Not applied" stays right)
 *   applied                                 -> kept; evidence / confirmation_text / reason_detail / artifacts_prefix
 *                                              emptied (the proof screenshot is proofRetention.js's job)
 * Each call is one short transaction over at most `chunk` rows (FOR UPDATE SKIP LOCKED), so the loop never holds
 * long locks. Never throws; a missing function (migration not applied yet) is logged once and skipped.
 */
export const TASK_RETENTION_DAYS = 30;
export const TASK_RETENTION_FN = "aa_task_retention";
const MAX_CHUNK = 2000;

export async function cleanupOldTasks({ db, chunk = 500, maxCalls = 40 } = {}) {
  const size = Math.min(Math.max(Number(chunk) || 500, 1), MAX_CHUNK);
  const out = { calls: 0, processed: 0, snapshots: 0, deleted: 0, slimmed: 0 };
  try {
    while (out.calls < maxCalls) {
      const { data, error } = await db.rpc(TASK_RETENTION_FN, { p_limit: size, p_days: TASK_RETENTION_DAYS });
      out.calls++;
      if (error) {
        const missing = error.code === "PGRST202" || error.code === "42883" || /could not find the function|does not exist/i.test(error.message || "");
        if (missing) {
          console.warn("[autoapply/task-retention] aa_task_retention() missing: apply sql/47_task_retention.sql");
          return { ...out, skipped: "not_installed" };
        }
        throw error;
      }
      const r = data && typeof data === "object" ? data : {};
      const processed = Number(r.processed) || 0;
      out.processed += processed;
      out.snapshots += Number(r.snapshots) || 0;
      out.deleted += Number(r.deleted) || 0;
      out.slimmed += Number(r.slimmed) || 0;
      if (processed < size) break; // nothing more due (or only rows another transaction holds)
    }
    return out;
  } catch (e) {
    console.error("[autoapply/task-retention]", (e && e.message) || String(e));
    return { ...out, error: true };
  }
}

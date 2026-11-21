/**
 * Needs-you items of the worker's duplicate-application guard (sql/27b): a lease that expired while the task was
 * 'submitting' becomes needs_you reason_code 'verify_submission' with an item payload {reason: 'verify_submission'}.
 * The user checks the site and answers:
 *
 *   confirmSubmitted  'confirm_submitted' -> task 'applied' (submitted_at now) and ONE credit captured, through
 *                     the same path as the worker's applied result: no credit while the batch is refund_due /
 *                     refunding / refunded or already full; ledger 'capture' is unique per task, credits_used + 1
 *                     only when that row was inserted (-> 'completed' on the last credit).
 *                     Primary path: RPC aa_confirm_submitted (sql/27, one transaction). Without it (sql/27 not
 *                     applied yet) the same steps run with conditional updates.
 *   notSubmitted      'not_submitted' -> task back to 'queued' (attempt + 1, lease cleared) when the batch is still
 *                     running / waiting_supply with credits left, else 'skipped' (reason_code 'not_submitted').
 */
export const VERIFY_REASON = "verify_submission";
export const REFUND_STATES = ["refund_due", "refunding", "refunded"];
const REQUEUE_BATCH = ["running", "waiting_supply"];

export const isVerifyItem = (item) => !!item && !!item.payload && item.payload.reason === VERIFY_REASON;

const isDup = (err) => err && (err.code === "23505" || /duplicate key/i.test(String(err.message || "")));
const rpcMissing = (err) => !!err && (["PGRST202", "42883"].includes(err.code) || /aa_confirm_submitted/i.test(String(err.message || "")));

/** Pure: may this batch be charged for one more application? -> [ok, why] (same rule as the worker's chargeable). */
export function chargeable(batch) {
  if (!batch) return [false, "batch_missing"];
  if (REFUND_STATES.includes(batch.status)) return [false, `batch_${batch.status}`];
  if ((Number(batch.credits_used) || 0) >= (Number(batch.credits_total) || 0)) return [false, "batch_full"];
  return [true, null];
}

async function confirmFallback({ db, taskId, userId, now }) {
  const { data: task, error } = await db.from("aa_tasks").select("*").eq("id", taskId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!task) return { ok: false, error: "not_found" };
  if (task.status === "applied") {
    const { data: cap, error: cErr } = await db.from("aa_credit_ledger").select("id").eq("task_id", taskId).eq("reason", "capture").limit(1);
    if (cErr) throw cErr;
    return { ok: true, already: true, charged: !!(cap && cap.length) };
  }
  if (task.status !== "needs_you") return { ok: false, error: "invalid_state", status: task.status };

  const { data: won, error: uErr } = await db
    .from("aa_tasks")
    .update({ status: "applied", submitted_at: now.toISOString(), reason_code: null, reason_detail: null, claimed_by: null, claimed_at: null, lease_until: null })
    .eq("id", taskId)
    .eq("user_id", userId)
    .eq("status", "needs_you")
    .select("id");
  if (uErr) throw uErr;
  if (!won || !won[0]) return confirmFallback({ db, taskId, userId, now }); // changed meanwhile: report what it is now

  const { data: batch, error: bErr } = await db.from("aa_batches").select("id, status, credits_used, credits_total").eq("id", task.batch_id).maybeSingle();
  if (bErr) throw bErr;
  const [ok, why] = chargeable(batch);
  if (!ok) return { ok: true, charged: false, reason: why };
  const { error: lErr } = await db
    .from("aa_credit_ledger")
    .insert({ user_id: task.user_id, batch_id: task.batch_id, delta: -1, reason: "capture", task_id: taskId });
  if (lErr) {
    if (isDup(lErr)) return { ok: true, charged: false, reason: "already_captured" };
    throw lErr;
  }
  // compare-and-set on credits_used (no transaction here): retry when another capture moved it
  for (let j = 0; j < 5; j++) {
    const used = Number(batch.credits_used) || 0;
    const next = used + 1 >= Number(batch.credits_total) && batch.status !== "cancelled" ? "completed" : batch.status;
    const { data: upd, error: cuErr } = await db
      .from("aa_batches")
      .update({ credits_used: used + 1, status: next })
      .eq("id", batch.id)
      .eq("credits_used", used)
      .eq("status", batch.status)
      .select("id");
    if (cuErr) throw cuErr;
    if (upd && upd[0]) return { ok: true, charged: true, reason: null };
    const { data: fresh, error: fErr } = await db.from("aa_batches").select("id, status, credits_used, credits_total").eq("id", batch.id).maybeSingle();
    if (fErr) throw fErr;
    Object.assign(batch, fresh || {});
    if (REFUND_STATES.includes(batch.status)) break; // refund started meanwhile: the capture row stays, counted below
  }
  console.error(`[autoapply/verify] task ${taskId}: capture recorded but credits_used not incremented (batch ${task.batch_id})`);
  return { ok: true, charged: true, reason: "credits_used_not_updated" };
}

/** -> { ok, charged, reason, already?, error?, status? } */
export async function confirmSubmitted({ db, taskId, userId, now = new Date() }) {
  const { data, error } = await db.rpc("aa_confirm_submitted", { p_task: taskId, p_user: userId });
  if (!error && data && typeof data === "object") return data;
  if (error && !rpcMissing(error)) throw error;
  return confirmFallback({ db, taskId, userId, now });
}

/** -> { ok, status: 'queued'|'skipped'|<current>, changed } */
export async function notSubmitted({ db, taskId, userId, now = new Date() }) {
  const { data: task, error } = await db.from("aa_tasks").select("*").eq("id", taskId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!task) return { ok: false, error: "not_found" };
  if (task.status !== "needs_you") return { ok: true, status: task.status, changed: false };
  const { data: batch, error: bErr } = await db.from("aa_batches").select("id, status, credits_used, credits_total").eq("id", task.batch_id).maybeSingle();
  if (bErr) throw bErr;
  const requeue = !!batch && REQUEUE_BATCH.includes(batch.status) && (Number(batch.credits_used) || 0) < (Number(batch.credits_total) || 0);
  const patch = requeue
    ? { status: "queued", attempt: (Number(task.attempt) || 0) + 1, not_before: now.toISOString(), reason_code: null, reason_detail: null, claimed_by: null, claimed_at: null, lease_until: null }
    : { status: "skipped", reason_code: "not_submitted", claimed_by: null, claimed_at: null, lease_until: null };
  const { data: upd, error: uErr } = await db
    .from("aa_tasks")
    .update(patch)
    .eq("id", taskId)
    .eq("user_id", userId)
    .eq("status", "needs_you")
    .select("id, status");
  if (uErr) throw uErr;
  if (!upd || !upd[0]) {
    const { data: again } = await db.from("aa_tasks").select("status").eq("id", taskId).maybeSingle();
    return { ok: true, status: again && again.status, changed: false };
  }
  return { ok: true, status: patch.status, changed: true };
}

/**
 * What is happening with a batch right now, in plain words, for the batch page.
 *   buckets: queued / applying / applied / needs_you / not_applied (from the task statuses)
 *   engine:  the shared apply server (aa_worker_launches, started on demand by aa-control): 'off' | 'starting' | 'running'
 *   message: one sentence for the user
 */
const QUEUED = ["shortlisted", "queued"];
const APPLYING = ["claimed", "running", "waiting_code", "submitting"];
const NOT_APPLIED = ["skipped", "failed", "removed", "cancelled"];
// aa-control checks every 5 min and wakes the server when >= 5 applications are due or the oldest waited 30 min;
// the server then needs ~5 min to boot. 40 min is the honest upper bound shown to the user.
const START_WITHIN_MIN = 40;

export function buckets(counts = {}) {
  const sum = (keys) => keys.reduce((n, k) => n + (Number(counts[k]) || 0), 0);
  return {
    queued: sum(QUEUED),
    applying: sum(APPLYING),
    applied: Number(counts.applied) || 0,
    needs_you: Number(counts.needs_you) || 0,
    not_applied: sum(NOT_APPLIED),
  };
}

const fmtTime = (iso) =>
  new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", day: "numeric", month: "short" });

/** batch: aa_batches row; counts: {status: n}; nextAt: earliest not_before of this batch's queued tasks (ISO|null);
 *  engine: 'off' | 'starting' | 'running'. */
export function liveStatus({ batch, counts = {}, nextAt = null, engine = "off", now = new Date() }) {
  const b = buckets(counts);
  const st = batch && batch.status;
  const total = Number(batch && batch.credits_total) || 0;
  const used = Number(batch && batch.credits_used) || 0;
  let phase = "waiting";
  let message;

  if (st === "pending_payment") {
    message = "Waiting for the payment to be confirmed.";
  } else if (st === "waiting_profile") {
    message = "Paused until your profile is complete. Finish setup and we start right away.";
  } else if (st === "paid" || st === "shortlisting") {
    phase = "preparing";
    message = "Payment confirmed. We are picking the best matching jobs for you (usually within 30 minutes).";
  } else if (st === "review") {
    message = "Your shortlist is ready. Review it and approve to start applying.";
  } else if (st === "paused") {
    message = batch.cancel_requested_at
      ? "Cancelling: finishing the applications already in progress, then unused credits are refunded."
      : "Paused. Resume whenever you are ready.";
  } else if (st === "completed" || st === "expired") {
    phase = "done";
    message = `Finished: ${b.applied} application${b.applied === 1 ? "" : "s"} submitted.`;
  } else if (st === "refund_due" || st === "refunding" || st === "refunded") {
    phase = "done";
    message = st === "refunded" ? "Finished. Unused credits were refunded." : "Finished. Unused credits are being refunded.";
  } else if (st === "cancelled") {
    phase = "done";
    message = "Cancelled.";
  } else if (b.applying > 0) {
    phase = "applying";
    message = `Applying now: ${b.applying} application${b.applying === 1 ? "" : "s"} in progress.`;
  } else if (b.queued > 0 && engine === "starting") {
    phase = "starting";
    message = "Starting our application server. Applications begin in about 5 minutes.";
  } else if (b.queued > 0 && nextAt && new Date(nextAt).getTime() > now.getTime() + 60_000) {
    message = `Next application at about ${fmtTime(nextAt)} IST. We space applications out (per site and at most 60 a day) so they are not flagged as spam.`;
  } else if (b.queued > 0) {
    message = engine === "running"
      ? "Queued: the next applications start in a few minutes."
      : `Queued: applications start within about ${START_WITHIN_MIN} minutes.`;
  } else if (st === "waiting_supply") {
    message = "Waiting for new matching jobs. We check new postings every day; unused credits are refunded if none turn up.";
  } else if (used >= total && total > 0) {
    phase = "done";
    message = `All ${total} credits used.`;
  } else {
    message = "Looking for more matching jobs.";
  }
  return { phase, engine, next_at: nextAt, buckets: b, message };
}

/** The on-demand server's state from aa_worker_launches (newest active launch). Never throws. */
export async function engineState(db) {
  try {
    const { data, error } = await db
      .from("aa_worker_launches")
      .select("status, created_at")
      .in("status", ["starting", "running", "stopping"])
      .order("created_at", { ascending: false })
      .limit(1);
    if (error || !data || !data.length) return "off";
    return data[0].status === "starting" ? "starting" : data[0].status === "running" ? "running" : "off";
  } catch {
    return "off";
  }
}

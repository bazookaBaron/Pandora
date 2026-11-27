/**
 * What is happening with a batch right now, in plain words, for the batch page.
 *   buckets: queued / applying / applied / needs_you / not_applied (from the task statuses)
 *   engine:  the shared apply server (aa_worker_launches, started on demand by aa-control): 'off' | 'starting' | 'running'
 *   message: one sentence for the user
 */
import { AUTO_APPLY } from "../../config/tiers.js";

const QUEUED = ["shortlisted", "queued"];
const APPLYING = ["claimed", "running", "waiting_code", "submitting"];
const NOT_APPLIED = ["skipped", "failed", "removed", "cancelled"];
// aa-control checks every 5 min and wakes the server when >= 5 applications are due or the oldest waited 30 min;
// the server then needs ~5 min to boot. Only when the control row gives no better reason is the generic
// "within about 40 minutes" line used.
const START_WITHIN_MIN = 40;
const CONTROL_STALE_MS = 15 * 60 * 1000;
const WALLET_DONE = ["finished_partial"];

/** Key under which a task row is counted for the live status: an application in an active status only counts as
 *  'applying' while its lease is alive (lease_until > now); a dead lease is swept back to the queue by a worker. */
export function liveKey(task, now = new Date()) {
  const st = task && task.status;
  if (APPLYING.includes(st)) {
    const l = task.lease_until ? new Date(task.lease_until).getTime() : 0;
    return l > now.getTime() ? st : "stale_lease";
  }
  return st;
}

/** [{status, lease_until}] -> {status|stale_lease: n} */
export function liveCounts(rows, now = new Date()) {
  const out = {};
  for (const t of rows || []) {
    const k = liveKey(t, now);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

export function buckets(counts = {}) {
  const sum = (keys) => keys.reduce((n, k) => n + (Number(counts[k]) || 0), 0);
  return {
    queued: sum(QUEUED) + (Number(counts.stale_lease) || 0),
    applying: sum(APPLYING),
    applied: Number(counts.applied) || 0,
    needs_you: Number(counts.needs_you) || 0,
    not_applied: sum(NOT_APPLIED),
  };
}

const rupeesText = (paise) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;

const fmtTime = (iso) =>
  new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", day: "numeric", month: "short" });

/** batch: aa_batches row; counts: {status: n}; nextAt: earliest not_before of this batch's queued tasks (ISO|null);
 *  engine: 'off' | 'starting' | 'running'. */
export function liveStatus({ batch, counts = {}, nextAt = null, engine = "off", dailyCapReached = false, now = new Date() }) {
  const info = typeof engine === "object" && engine ? engine : { state: engine || "off" };
  engine = info.state || "off";
  const b = buckets(counts);
  const st = batch && batch.status;
  const total = Number(batch && batch.credits_total) || 0;
  const used = Number(batch && batch.credits_used) || 0;
  const wallet = !!batch && batch.rate_paise != null;
  const idleH = AUTO_APPLY.wallet.idle_close_hours;
  let phase = "waiting";
  let message;

  if (st === "pending_payment") {
    message = "Waiting for the payment to be confirmed.";
  } else if (st === "waiting_profile") {
    message = "Paused until your profile is complete. Finish setup and we start right away.";
  } else if (st === "paid" || st === "shortlisting") {
    phase = "preparing";
    message = wallet
      ? "Your batch has started. We are picking the best matching jobs for you (usually within 30 minutes)."
      : "Payment confirmed. We are picking the best matching jobs for you (usually within 30 minutes).";
  } else if (st === "waiting_funds") {
    const left = Math.max(0, total - used);
    message = `Wallet empty. Add money to continue (${left} application${left === 1 ? "" : "s"} left in this batch). It resumes by itself after you top up.`;
  } else if (st === "review") {
    message = "Your shortlist is ready. Review it and approve to start applying.";
  } else if (st === "paused") {
    message = wallet
      ? "Paused. Resume any time; the money held for this batch stays reserved."
      : `Paused. Resume any time: we keep going until all ${total} applications are submitted.`;
  } else if (st === "completed" || st === "expired") {
    phase = "done";
    message = `Finished: ${b.applied} application${b.applied === 1 ? "" : "s"} submitted.`;
  } else if (WALLET_DONE.includes(st)) {
    phase = "done";
    const left = Math.max(0, total - used);
    message = `Finished: ${b.applied} application${b.applied === 1 ? "" : "s"} submitted. We found no more matching jobs; the unused money for ${left} application${left === 1 ? "" : "s"} is back in your wallet.`;
  } else if (st === "refund_due" || st === "refunding" || st === "refunded") {
    // only payment-safety or admin refunds reach these states (a bought batch is never refunded automatically)
    phase = "done";
    // one short line; the amount only when something was actually paid back (a ₹0 line is noise)
    const paise = Number(batch && batch.refund_paise) || 0;
    message = st !== "refunded"
      ? "This payment is being refunded."
      : paise > 0 ? `Refunded ${rupeesText(paise)}.` : "This payment was refunded.";
  } else if (st === "cancelled") {
    phase = "done";
    message = wallet ? "Stopped. The unused money is back in your wallet." : "Cancelled.";
  } else if (b.applying > 0) {
    phase = "applying";
    message = `Applying now: ${b.applying} application${b.applying === 1 ? "" : "s"} in progress.`;
  } else if (b.queued > 0 && engine === "starting") {
    phase = "starting";
    message = "Starting our application server. Applications begin in about 5 minutes.";
  } else if (b.queued > 0 && dailyCapReached) {
    message = `Today's limit of ${AUTO_APPLY.daily_cap} applications is reached. We continue tomorrow.`;
  } else if (b.queued > 0 && nextAt && new Date(nextAt).getTime() > now.getTime() + 60_000) {
    message = `Next application at about ${fmtTime(nextAt)} IST. We space applications out (per site and at most ${AUTO_APPLY.daily_cap} a day) so they are not flagged as spam.`;
  } else if (b.queued > 0 && engine === "running") {
    message = "Queued: the next applications start in a few minutes.";
  } else if (b.queued > 0) {
    message = engineReason(info, now) || `Queued: applications start within about ${START_WITHIN_MIN} minutes.`;
  } else if (st === "waiting_supply") {
    message = wallet
      ? `Waiting for new matching jobs. We check new postings every day and widen the search. If nothing new turns up for ${idleH} hours we close the batch and return the unused money to your wallet.`
      : `Waiting for new matching jobs. We check new postings every day and widen the search; we keep going until all ${total} applications are submitted.`;
  } else if (used >= total && total > 0) {
    phase = "done";
    message = `All ${total} credits used.`;
  } else if (b.needs_you > 0 && used + b.needs_you >= total) {
    message = "Almost done: the last applications need a few details from you. Open Needs you to fill one short form.";
  } else {
    message = wallet
      ? "Looking for more matching jobs. Unused money returns to your wallet when the batch ends."
      : `Looking for more matching jobs. We keep going until all ${total} applications are submitted.`;
  }
  return { phase, engine, next_at: nextAt, buckets: b, message };
}

/** One plain sentence from the control row's reason (null when there is nothing better than the generic line). */
export function engineReason(info, now = new Date()) {
  if (!info) return null;
  if (info.stale) return "Our scheduler has not checked in for a while. Your applications are safe and resume as soon as it does.";
  const until = info.cooldown_until && new Date(info.cooldown_until).getTime() > now.getTime() ? info.cooldown_until : null;
  switch (info.reason) {
    case "cooldown":
      return until ? `Our application server is resting until about ${fmtTime(until)} IST, then it starts again.` : "Our application server is resting for a short while, then it starts again.";
    case "daily_spend_cap":
      return "Today's server budget is used up. Applications resume tomorrow.";
    case "daily_launch_cap":
      return "We reached today's limit of server starts. Applications resume tomorrow.";
    case "fail_cooldown":
      return "Our last server start did not work out. We retry shortly.";
    case "below_wake":
    case "no_work":
      return `Waiting for a few more applications to be due, then we start the server (within about ${START_WITHIN_MIN} minutes).`;
    case "disabled":
    case "not_configured":
      return "Our application server is switched off at the moment. Applications resume when it is back.";
    default:
      return null;
  }
}

/**
 * The on-demand server's state: { state: 'off'|'starting'|'running', reason, cooldown_until, due, stale } from
 * aa_worker_launches (newest active launch) and the aa-control row of aa_health (stats.autoscale.reason /
 * cooldown_until). Never throws.
 */
export async function engineState(db) {
  const out = { state: "off", reason: null, cooldown_until: null, due: null, stale: false };
  try {
    const { data, error } = await db
      .from("aa_worker_launches")
      .select("status, created_at")
      .in("status", ["starting", "running", "stopping"])
      .order("created_at", { ascending: false })
      .limit(1);
    if (!error && data && data.length) {
      out.state = data[0].status === "starting" ? "starting" : data[0].status === "running" ? "running" : "off";
    }
  } catch {
    return out;
  }
  if (out.state !== "off") return out;
  try {
    const { data } = await db.from("aa_health").select("component, last_seen, stats").in("component", ["control", "control:spend"]);
    const rows = Object.fromEntries((data || []).map((r) => [r.component, r]));
    const ctl = rows.control;
    if (ctl) {
      const auto = (ctl.stats && ctl.stats.autoscale) || {};
      out.reason = auto.reason || null;
      out.due = auto.due ?? null;
      out.cooldown_until = auto.cooldown_until || (rows["control:spend"] && rows["control:spend"].stats && rows["control:spend"].stats.cooldown_until) || null;
      if (ctl.last_seen && Date.now() - new Date(ctl.last_seen).getTime() > CONTROL_STALE_MS) out.stale = true;
      if (["launching", "launch"].includes(auto.action)) out.state = "starting";
    }
  } catch {
    /* the reason is a nicety */
  }
  return out;
}

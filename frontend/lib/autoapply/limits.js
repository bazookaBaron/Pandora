/**
 * AutoApply limits: IST calendar math + per-user monthly/daily usage.
 * IST = UTC+05:30 (no DST), so plain offset arithmetic is exact.
 */
import { AUTO_APPLY } from "../../config/tiers.js";

const IST_OFFSET_MS = 330 * 60 * 1000;

/** Start of the current IST calendar month, as a UTC Date. */
export function istMonthStart(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_OFFSET_MS);
}

/** Start of the current IST calendar day, as a UTC Date. */
export function istDayStart(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS);
}

export function isEligiblePlan(plan) {
  return AUTO_APPLY.plans.includes(plan);
}

export function packPrice(kind, size) {
  const p = AUTO_APPLY.packs[kind];
  const v = p && p[size];
  return Number.isInteger(v) ? v : null;
}

/** Statuses whose unused credits are (being) refunded: only credits_used counts toward the cap. */
export const REFUND_STATUSES = ["refund_due", "refunding", "refunded"];
/** A pending order this young still holds its credits against the cap (a checkout may be under way). */
export const PENDING_HOLD_MS = 30 * 60 * 1000;

/**
 * Credits counted against this IST month's cap:
 *  • batches purchased this month — a refunded (or refund pending) batch counts only its used credits;
 *  • with includePending, pending_payment orders created in the last 30 min (checkouts in progress).
 * excludeBatchId leaves one batch out (markBatchPaid re-checks the cap for the batch being paid).
 */
export async function monthPurchased(db, userId, now = new Date(), { includePending = false, excludeBatchId = null } = {}) {
  const { data, error } = await db
    .from("aa_batches")
    .select("id, credits_total, credits_used, status, rate_paise")
    .eq("user_id", userId)
    .gte("purchased_at", istMonthStart(now).toISOString());
  if (error) throw error;
  let sum = 0;
  for (const r of data || []) {
    if (excludeBatchId && r.id === excludeBatchId) continue;
    // a closed wallet batch (finished_partial / stopped) only counts what was really used
    const usedOnly = REFUND_STATUSES.includes(r.status) || r.status === "finished_partial" || (r.rate_paise != null && r.status === "cancelled");
    sum += usedOnly ? Math.max(0, Number(r.credits_used) || 0) : Number(r.credits_total) || 0;
  }
  if (includePending) {
    const { data: pend, error: pErr } = await db
      .from("aa_batches")
      .select("id, credits_total")
      .eq("user_id", userId)
      .eq("status", "pending_payment")
      .is("purchased_at", null)
      .gte("created_at", new Date(now.getTime() - PENDING_HOLD_MS).toISOString());
    if (pErr) throw pErr;
    for (const r of pend || []) if (!(excludeBatchId && r.id === excludeBatchId)) sum += Number(r.credits_total) || 0;
  }
  return sum;
}

async function countApplied(db, userId, since) {
  const { count, error } = await db
    .from("aa_tasks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "applied")
    .gte("submitted_at", since.toISOString());
  if (error) throw error;
  return count || 0;
}

export async function usageFor(db, userId, now = new Date()) {
  const [purchased, monthApplied, todayApplied] = await Promise.all([
    monthPurchased(db, userId, now),
    countApplied(db, userId, istMonthStart(now)),
    countApplied(db, userId, istDayStart(now)),
  ]);
  return {
    month_purchased: purchased,
    month_applied: monthApplied,
    monthly_cap: AUTO_APPLY.monthly_cap,
    remaining_purchasable: Math.max(0, AUTO_APPLY.monthly_cap - purchased),
    today_applied: todayApplied,
    daily_cap: AUTO_APPLY.daily_cap,
  };
}

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

/** Credits purchased this IST month (batches with purchased_at in the month). */
export async function monthPurchased(db, userId, now = new Date()) {
  const { data, error } = await db
    .from("aa_batches")
    .select("credits_total")
    .eq("user_id", userId)
    .gte("purchased_at", istMonthStart(now).toISOString());
  if (error) throw error;
  return (data || []).reduce((s, r) => s + (Number(r.credits_total) || 0), 0);
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

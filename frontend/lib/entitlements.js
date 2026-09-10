/**
 * Server-side entitlement system. Config-driven: every limit, plan name and
 * feature key comes from `../config/tiers.js` — nothing is hard-coded here.
 *
 * Trust model: the client is never trusted for plan or usage. Everything is
 * read from Supabase through the service-role client (`supabaseAdmin`), which
 * bypasses RLS.
 *
 * ── Lazy check-on-access (no cron needed) ────────────────────────────────────
 * `getUserPlan` derives the *effective* plan every time it is called:
 *   • status active / on_trial      -> the row's plan
 *   • status cancelled / past_due   -> the row's plan while current_period_end
 *                                      is in the future; 'free' once it passes
 *   • status expired / paused / etc -> 'free'
 *   • no row                        -> 'free' (and a warning is logged — the
 *                                      signup trigger should have made one)
 * A subscription that has lapsed therefore downgrades itself the next time the
 * user hits an entitlement path; no scheduled job is required.
 *
 * ── Usage periods ───────────────────────────────────────────────────────────
 *   • free users  : calendar month, UTC. [1st 00:00 this month, 1st next month)
 *   • paid users  : a one-month window aligned to current_period_end's
 *                   day-of-month, rolled to the current month (rolled forward
 *                   one month once that instant is in the past). Yearly billing
 *                   still meters monthly with this same window.
 */
import {
  TIERS,
  METERED_FEATURES,
  USAGE_LIMIT_KEY,
  isValidPlan,
  getLimit,
  isUnlimited,
  serializeLimit,
} from "../config/tiers.js";
import { supabaseAdmin } from "./supabaseAdmin.js";

// ── tiny subscription-row cache (bounds Supabase round-trips) ────────────────
const SUB_TTL_MS = 15 * 1000;
const SUB_MAX = 500;
/** @type {Map<string, { row: any, exp: number }>} */
const subCache = new Map();

function subCacheSet(userId, row) {
  if (subCache.size >= SUB_MAX) {
    const k = subCache.keys().next().value;
    if (k !== undefined) subCache.delete(k);
  }
  subCache.set(userId, { row, exp: Date.now() + SUB_TTL_MS });
}

// ── per-user entitlements-summary cache (GET /api/entitlements/me) ───────────
// The summary fans out to ~6 Supabase reads; this collapses repeated calls
// within a short window to a single computed result.
const SUMMARY_TTL_MS = 20_000;
const SUMMARY_MAX = 500;
/** @type {Map<string, { value: any, exp: number }>} */
const summaryCache = new Map();

function summaryCacheSet(userId, value) {
  if (summaryCache.size >= SUMMARY_MAX) {
    const k = summaryCache.keys().next().value;
    if (k !== undefined) summaryCache.delete(k);
  }
  summaryCache.set(userId, { value, exp: Date.now() + SUMMARY_TTL_MS });
}

/** Read the user's single subscriptions row (cached ~15s). null if none. */
async function getSubscription(userId) {
  const hit = subCache.get(userId);
  if (hit && Date.now() < hit.exp) return hit.row;

  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("plan,status,provider,billing_period,current_period_end")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error(
      "[entitlements] subscriptions read failed:",
      error.message || error,
    );
    // Fail closed to 'free' by returning null; caller logs the missing-row path.
    return null;
  }
  subCacheSet(userId, data || null);
  return data || null;
}

/** Invalidate the cached subscription row for a user (e.g. after a webhook). */
export function invalidateUser(userId) {
  subCache.delete(userId);
  summaryCache.delete(userId);
}

// ── plan resolution (lazy check-on-access) ──────────────────────────────────
export async function getUserPlan(userId) {
  const row = await getSubscription(userId);
  if (!row) {
    console.warn(
      `[entitlements] no subscriptions row for user ${userId} — defaulting to 'free' (signup trigger should have created one)`,
    );
    return "free";
  }

  const plan = isValidPlan(row.plan) ? row.plan : "free";
  if (plan === "free") return "free";

  const status = row.status;
  if (status === "active" || status === "on_trial") return plan;

  if (status === "cancelled" || status === "past_due") {
    const end = row.current_period_end
      ? new Date(row.current_period_end).getTime()
      : 0;
    return end > Date.now() ? plan : "free";
  }

  // expired | paused | unknown
  return "free";
}

// ── period math ────────────────────────────────────────────────────────────
function daysInMonth(year, monthIdx) {
  return new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
}

function freePeriod(now = new Date()) {
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(y, mo, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(y, mo + 1, 1, 0, 0, 0, 0)),
  };
}

function paidPeriod(currentPeriodEnd, now = new Date()) {
  const cpe = new Date(currentPeriodEnd);
  if (Number.isNaN(cpe.getTime())) return freePeriod(now);

  const h = cpe.getUTCHours();
  const mi = cpe.getUTCMinutes();
  const s = cpe.getUTCSeconds();
  const ms = cpe.getUTCMilliseconds();
  const anchorDom = cpe.getUTCDate();

  const mk = (yy, mm) => {
    const dom = Math.min(anchorDom, daysInMonth(yy, mm));
    return new Date(Date.UTC(yy, mm, dom, h, mi, s, ms));
  };

  let y = now.getUTCFullYear();
  let mo = now.getUTCMonth();
  let end = mk(y, mo);
  if (end.getTime() <= now.getTime()) {
    mo += 1;
    if (mo > 11) {
      mo = 0;
      y += 1;
    }
    end = mk(y, mo);
  }

  let sy = y;
  let sm = mo - 1;
  if (sm < 0) {
    sm = 11;
    sy -= 1;
  }
  const start = mk(sy, sm);
  return { start, end };
}

/** @returns {Promise<{ start: Date, end: Date }>} */
export async function getPeriod(userId) {
  const [plan, row] = await Promise.all([
    getUserPlan(userId),
    getSubscription(userId),
  ]);
  if (plan !== "free" && row && row.current_period_end) {
    return paidPeriod(row.current_period_end);
  }
  return freePeriod();
}

// ── usage reads ────────────────────────────────────────────────────────────
async function readUsageCount(userId, feature, periodStartISO) {
  try {
    const { data, error } = await supabaseAdmin
      .from("usage")
      .select("usage_count")
      .eq("user_id", userId)
      .eq("feature", feature)
      .eq("period_start", periodStartISO)
      .maybeSingle();
    if (error) {
      console.error("[entitlements] usage read failed:", error.message || error);
      return 0; // fail-open on transient read errors
    }
    return data?.usage_count ?? 0;
  } catch (e) {
    console.error("[entitlements] usage read threw:", e?.message || e);
    return 0;
  }
}

// ── public: can this user use `feature` right now? ─────────────────────────
/**
 * @param {string} userId
 * @param {string} feature  metered key (hld_practice|resume_optimizer|ai_explanation)
 *                          OR a catalog key: 'hld_catalog'
 * @returns {Promise<{ allowed: boolean, reason?: string, remaining?: number,
 *                     limit?: number|string, used?: number, resetsAt?: string,
 *                     plan?: string }>}
 */
export async function canAccess(userId, feature, _context) {
  const plan = await getUserPlan(userId);

  // Catalog-style gate.
  if (feature === "hld_catalog") {
    const access = getLimit(plan, "hld_catalog_access"); // 'list_only' | 'full'
    const allowed = access !== "list_only";
    return {
      allowed,
      plan,
      limit: access,
      reason: allowed ? undefined : "upgrade_required",
    };
  }

  // Metered gate.
  if (!METERED_FEATURES.includes(feature)) {
    throw new Error(`canAccess: unknown feature "${feature}"`);
  }

  const limit = getLimit(plan, USAGE_LIMIT_KEY[feature]);

  if (isUnlimited(limit)) {
    return { allowed: true, plan, limit: serializeLimit(limit) };
  }

  const period = await getPeriod(userId);
  const used = await readUsageCount(
    userId,
    feature,
    period.start.toISOString(),
  );
  const allowed = used < limit;
  return {
    allowed,
    plan,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetsAt: period.end.toISOString(),
    reason: allowed ? undefined : "usage_limit",
  };
}

/**
 * @returns {Promise<{ used: number, limit: number, resetsAt: string }>}
 * `limit` is a finite number or Infinity (not serialized).
 */
export async function getRemainingUsage(userId, feature) {
  if (!METERED_FEATURES.includes(feature)) {
    throw new Error(`getRemainingUsage: unknown feature "${feature}"`);
  }
  const plan = await getUserPlan(userId);
  const rawLimit = getLimit(plan, USAGE_LIMIT_KEY[feature]);
  const limit = isUnlimited(rawLimit) ? Infinity : rawLimit;
  const period = await getPeriod(userId);
  const used = await readUsageCount(
    userId,
    feature,
    period.start.toISOString(),
  );
  return { used, limit, resetsAt: period.end.toISOString() };
}

// ── public: bump a counter AFTER the gated action succeeded ────────────────
export async function incrementUsage(userId, feature) {
  if (!METERED_FEATURES.includes(feature)) {
    throw new Error(`incrementUsage: unknown feature "${feature}"`);
  }
  const period = await getPeriod(userId);
  const startISO = period.start.toISOString();
  const endISO = period.end.toISOString();

  // Preferred path: atomic Postgres function (see sql/07_increment_usage_fn.sql).
  const rpc = await supabaseAdmin.rpc("increment_usage", {
    p_user_id: userId,
    p_feature: feature,
    p_period_start: startISO,
    p_period_end: endISO,
  });
  if (!rpc.error) {
    summaryCache.delete(userId); // next /api/entitlements/me must reflect the bump
    return;
  }

  const msg = String(rpc.error.message || rpc.error.code || "");
  const rpcMissing =
    rpc.error.code === "PGRST202" ||
    /does not exist|could not find|schema cache|function .* increment_usage/i.test(
      msg,
    );
  if (!rpcMissing) {
    console.error("[entitlements] increment_usage rpc failed:", msg);
    // fall through to the best-effort path anyway
  }

  // Fallback: upsert a baseline row, then read-modify-write.
  // NOTE: there is a small race window between the SELECT and UPDATE here —
  // two writes that interleave can under-count by one. The RPC path above has
  // no such window; run sql/07_increment_usage_fn.sql to use it.
  try {
    await supabaseAdmin.from("usage").upsert(
      {
        user_id: userId,
        feature,
        period_start: startISO,
        period_end: endISO,
        usage_count: 0,
      },
      { onConflict: "user_id,feature,period_start", ignoreDuplicates: true },
    );
    const { data } = await supabaseAdmin
      .from("usage")
      .select("usage_count")
      .eq("user_id", userId)
      .eq("feature", feature)
      .eq("period_start", startISO)
      .maybeSingle();
    await supabaseAdmin
      .from("usage")
      .update({ usage_count: (data?.usage_count ?? 0) + 1 })
      .eq("user_id", userId)
      .eq("feature", feature)
      .eq("period_start", startISO);
    summaryCache.delete(userId); // next /api/entitlements/me must reflect the bump
  } catch (e) {
    console.error("[entitlements] incrementUsage fallback failed:", e?.message || e);
  }
}

// ── summary for GET /api/entitlements/me ───────────────────────────────────
export async function getEntitlementsSummary(userId) {
  const hit = summaryCache.get(userId);
  if (hit && Date.now() < hit.exp) return hit.value;

  const plan = await getUserPlan(userId);
  const rawLimits = (TIERS[plan] || TIERS.free).limits;
  const limits = {};
  for (const [k, v] of Object.entries(rawLimits)) limits[k] = serializeLimit(v);

  // Fan the per-feature usage reads out in parallel instead of awaiting a
  // serial loop (~6 sequential Supabase round-trips → 1 batched wait).
  const results = await Promise.all(
    METERED_FEATURES.map((f) => getRemainingUsage(userId, f)),
  );
  const usage = {};
  METERED_FEATURES.forEach((feature, i) => {
    const { used, limit, resetsAt } = results[i];
    usage[feature] = { used, limit: serializeLimit(limit), resetsAt };
  });

  const summary = { plan, limits, usage };
  summaryCacheSet(userId, summary);
  return summary;
}

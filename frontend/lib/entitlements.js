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
  PLAN_ORDER,
  METERED_FEATURES,
  USAGE_LIMIT_KEY,
  isValidPlan,
  getLimit,
  isUnlimited,
  serializeLimit,
} from "../config/tiers.js";
import { supabaseAdmin } from "./supabaseAdmin.js";
import { currencyForCountry } from "./geo.js";

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

const SUB_COLUMNS_LEGACY = "plan,status,provider,billing_period,current_period_end";
const SUB_COLUMNS =
  SUB_COLUMNS_LEGACY +
  ",cancel_at_period_end,grace_until,currency,admin_grant,pending_plan,provider_subscription_id";

/** Read the user's single subscriptions row (cached ~15s). null if none. */
async function getSubscription(userId) {
  const hit = subCache.get(userId);
  if (hit && Date.now() < hit.exp) return hit.row;

  let { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select(SUB_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  // sql/49 not applied yet (undefined column): fall back to the legacy columns
  // instead of failing every user to 'free'.
  if (error && (error.code === "42703" || /column .* does not exist/i.test(String(error.message)))) {
    ({ data, error } = await supabaseAdmin
      .from("subscriptions")
      .select(SUB_COLUMNS_LEGACY)
      .eq("user_id", userId)
      .maybeSingle());
  }

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

  return effectivePlanFromRow(row);
}

/**
 * Pure plan resolution for a subscriptions row (exported for tests).
 *
 * Paid access always needs a paid-through instant in the future:
 *   active / on_trial   -> only while current_period_end > now. An active paid
 *                          row with NO period end is NOT honoured forever (a
 *                          missed webhook must never leave a lapsed user on a
 *                          paid plan) - the sole exception is a legacy manual
 *                          grant flagged admin_grant=true (sql/49).
 *   cancelled           -> until current_period_end (cancel-at-cycle-end).
 *   past_due            -> a failed renewal: until current_period_end OR the
 *                          grace_until instant (3-day grace), whichever is later.
 *   halted / expired / paused / created / pending / unknown -> free, immediately.
 */
export function effectivePlanFromRow(row, now = Date.now()) {
  if (!row) return "free";
  const plan = isValidPlan(row.plan) ? row.plan : "free";
  if (plan === "free") return "free";

  const ts = (v) => {
    if (!v) return null;
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  };
  const end = ts(row.current_period_end);
  const grace = ts(row.grace_until);
  const status = row.status;

  if (status === "active" || status === "on_trial") {
    if (end !== null) return end > now ? plan : "free";
    return row.admin_grant === true ? plan : "free";
  }
  if (status === "cancelled") {
    return end !== null && end > now ? plan : "free";
  }
  if (status === "past_due") {
    const paidThrough = end !== null && end > now;
    const inGrace = grace !== null && grace > now;
    return paidThrough || inGrace ? plan : "free";
  }
  // halted | expired | paused | created | pending | authenticated | unknown
  return "free";
}

/**
 * Does `plan` satisfy a plan requirement? (pure; plans ordered free < pro < max)
 */
export function planAtLeast(plan, min = "pro") {
  const a = PLAN_ORDER.indexOf(plan);
  const b = PLAN_ORDER.indexOf(min);
  return a >= 0 && b >= 0 && a >= b;
}

/**
 * Server-side gate for paid-only features (AutoApply packs / wallet, etc.).
 * Resolves the user's EFFECTIVE plan (so a halted, lapsed, cancelled-and-ended
 * or grace-expired subscription is Free) and says whether it is enough.
 *
 *   const gate = await requiresActivePlan(userId);            // pro or max
 *   const gate = await requiresActivePlan(userId, { min: "max" });
 *   if (!gate.ok) return res.status(402).json({ error: "plan_required", plan: gate.plan });
 *
 * Never throws for a missing row (that is simply Free). Fails closed.
 * @returns {Promise<{ ok: boolean, plan: string, required: string }>}
 */
export async function requiresActivePlan(userId, { min = "pro" } = {}) {
  let plan = "free";
  try {
    plan = userId ? await getUserPlan(userId) : "free";
  } catch {
    plan = "free";
  }
  return { ok: planAtLeast(plan, min), plan, required: min };
}

/**
 * Billing details for the Plans / Me UI, derived from the raw row (pure).
 * Returns null for free users with nothing to manage.
 */
export function subscriptionView(row, now = Date.now()) {
  if (!row) return null;
  const effective = effectivePlanFromRow(row, now);
  if (effective === "free") return null;
  const providerSub = String(row.provider_subscription_id || "");
  const recurring = row.provider === "razorpay" && providerSub.startsWith("sub_");
  const cancelling = row.status === "cancelled" || row.cancel_at_period_end === true;
  return {
    plan: effective,
    status: row.status,
    billing_period: row.billing_period || null,
    current_period_end: row.current_period_end || null,
    cancel_at_period_end: cancelling,
    grace_until: row.status === "past_due" ? row.grace_until || null : null,
    pending_plan: row.pending_plan || null,
    recurring,
    // Legacy one-time / coupon / admin terms just end; nothing to cancel.
    can_cancel: recurring && !cancelling,
  };
}

// ── geo-based currency ───────────────────────────────────────────────────
// Read-only; the actual write happens in POST /api/profile/detect-country
// (server.js), fired once per login from AuthContext.jsx. Never throws —
// worst case a missing/unreachable profiles row just falls back to null,
// which currencyForCountry() treats as India (the safe default).
export async function getUserCountry(userId) {
  try {
    const { data } = await supabaseAdmin
      .from("profiles")
      .select("country")
      .eq("id", userId)
      .maybeSingle();
    return data?.country || null;
  } catch {
    return null;
  }
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

// ── atomic reserve-then-refund (sql/32_usage_reserve.sql) ──────────────────
/**
 * Atomically reserve one unit of `feature` BEFORE doing the gated work.
 * Replaces canAccess() + incrementUsage(), which let N parallel requests all
 * pass the check. On a successful reservation the caller MUST call
 * refundUsage(reservation) if the work then fails.
 *
 * @returns {Promise<{ allowed: boolean, reservation?: object, plan?: string,
 *   used?: number, limit?: number|string, remaining?: number, resetsAt?: string,
 *   reason?: string }>}  Same paywall fields as canAccess().
 */
export async function reserveUsage(userId, feature) {
  if (!METERED_FEATURES.includes(feature)) {
    throw new Error(`reserveUsage: unknown feature "${feature}"`);
  }
  const plan = await getUserPlan(userId);
  const rawLimit = getLimit(plan, USAGE_LIMIT_KEY[feature]);
  const period = await getPeriod(userId);
  const startISO = period.start.toISOString();
  const endISO = period.end.toISOString();
  const limit = isUnlimited(rawLimit) ? 2147483647 : rawLimit;

  const rpc = await supabaseAdmin.rpc("reserve_usage", {
    p_user: userId,
    p_feature: feature,
    p_limit: limit,
    p_period_start: startISO,
    p_period_end: endISO,
  });

  if (!rpc.error) {
    const n = Number(rpc.data);
    if (n >= 0) {
      summaryCache.delete(userId);
      return {
        allowed: true,
        plan,
        used: n,
        limit: isUnlimited(rawLimit) ? serializeLimit(rawLimit) : rawLimit,
        resetsAt: endISO,
        reservation: { userId, feature, periodStart: startISO, atomic: true },
      };
    }
    const used = await readUsageCount(userId, feature, startISO);
    return {
      allowed: false,
      plan,
      used,
      limit: rawLimit,
      remaining: 0,
      resetsAt: endISO,
      reason: "usage_limit",
    };
  }

  // Degrade to the legacy (racy) path ONLY when reserve_usage() is not deployed
  // (sql/30 not applied). Any other error (timeout, connection, permission)
  // fails closed: throwing makes the caller 5xx instead of silently bypassing
  // the atomic quota.
  if (!isMissingFunctionError(rpc.error)) {
    const msg = String(rpc.error.message || rpc.error.code || "");
    console.error("[entitlements] reserve_usage rpc failed:", msg);
    const e = new Error("usage reservation unavailable");
    e.status = 503;
    e.code = "usage_unavailable";
    throw e;
  }
  if (!_warnedNoReserveRpc) {
    _warnedNoReserveRpc = true;
    console.warn("[entitlements] reserve_usage() missing - apply sql/30_usage_reserve.sql; using non-atomic fallback.");
  }
  const gate = await canAccess(userId, feature);
  if (!gate.allowed) return gate;
  await incrementUsage(userId, feature);
  return {
    ...gate,
    reservation: { userId, feature, periodStart: startISO, atomic: false },
  };
}

let _warnedNoReserveRpc = false;

/**
 * True only for "function does not exist": PostgREST PGRST202 (not in schema
 * cache) or Postgres 42883 (undefined_function). Exported for tests.
 */
export function isMissingFunctionError(err) {
  if (!err) return false;
  const code = String(err.code || "");
  if (code === "PGRST202" || code === "42883") return true;
  const msg = String(err.message || "");
  return /could not find the function|function .* does not exist/i.test(msg);
}

/** Undo a reserveUsage() reservation (gated work failed). Never throws. */
export async function refundUsage(reservation) {
  if (!reservation) return;
  const { userId, feature, periodStart, atomic } = reservation;
  try {
    const rpc = await supabaseAdmin.rpc("refund_usage", {
      p_user: userId,
      p_feature: feature,
      p_period_start: periodStart,
    });
    if (rpc.error && !atomic) {
      // legacy best-effort decrement
      const { data } = await supabaseAdmin
        .from("usage")
        .select("usage_count")
        .eq("user_id", userId)
        .eq("feature", feature)
        .eq("period_start", periodStart)
        .maybeSingle();
      if (data && data.usage_count > 0) {
        await supabaseAdmin
          .from("usage")
          .update({ usage_count: data.usage_count - 1 })
          .eq("user_id", userId)
          .eq("feature", feature)
          .eq("period_start", periodStart);
      }
    } else if (rpc.error) {
      console.error("[entitlements] refund_usage failed:", rpc.error.message);
    }
    summaryCache.delete(userId);
  } catch (e) {
    console.error("[entitlements] refundUsage threw:", e?.message || e);
  }
}

// ── company-subscription count-cap (NOT monthly-metered) ───────────────────
// Unlike the METERED_FEATURES above (which reset on a monthly period), company
// subscriptions are a persistent cap: Free = 0 (locked out), Pro = 4, Max = 10
// (see config/tiers.js `company_subscriptions_max`). No `usage` table involved
// — just a live COUNT(*) against public.company_subscriptions.
export async function canAddCompanySubscription(userId) {
  const plan = await getUserPlan(userId);
  const limit = getLimit(plan, "company_subscriptions_max");

  if (!limit || (Number.isFinite(limit) && limit <= 0)) {
    return {
      allowed: false,
      plan,
      limit: serializeLimit(limit ?? 0),
      used: null,
      reason: "upgrade_required",
    };
  }

  const { count, error } = await supabaseAdmin
    .from("company_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (error) {
    console.error(
      "[entitlements] company_subscriptions count failed:",
      error.message || error,
    );
    // Fail closed — don't let a transient read error bypass the cap.
    return { allowed: false, plan, limit: serializeLimit(limit), used: null, reason: "error" };
  }

  const used = count || 0;
  const allowed = isUnlimited(limit) ? true : used < limit;
  return {
    allowed,
    plan,
    used,
    limit: serializeLimit(limit),
    remaining: isUnlimited(limit) ? null : Math.max(0, limit - used),
    reason: allowed ? undefined : "usage_limit",
  };
}

// ── summary for GET /api/entitlements/me ───────────────────────────────────
export async function getEntitlementsSummary(userId) {
  const hit = summaryCache.get(userId);
  if (hit && Date.now() < hit.exp) return hit.value;

  const plan = await getUserPlan(userId);
  const rawLimits = (TIERS[plan] || TIERS.free).limits;
  const limits = {};
  for (const [k, v] of Object.entries(rawLimits)) limits[k] = serializeLimit(v);

  // Fan the per-feature usage reads (+ the country read the pricing page
  // needs for currency) out in parallel instead of awaiting a serial loop.
  const [results, country] = await Promise.all([
    Promise.all(METERED_FEATURES.map((f) => getRemainingUsage(userId, f))),
    getUserCountry(userId),
  ]);
  const usage = {};
  METERED_FEATURES.forEach((feature, i) => {
    const { used, limit, resetsAt } = results[i];
    usage[feature] = { used, limit: serializeLimit(limit), resetsAt };
  });

  const subRow = await getSubscription(userId);
  const summary = {
    plan,
    limits,
    usage,
    currency: currencyForCountry(country),
    // false until detect-country has stored a country: the client then asks
    // GET /api/geo instead of trusting the INR fail-safe (avoids INR->USD flash).
    currency_known: !!country,
    subscription: subscriptionView(subRow),
  };
  summaryCacheSet(userId, summary);
  return summary;
}

// ── SINGLE SOURCE OF TRUTH for subscription tiers ────────────────────
// Edit numbers here only. Consumed by BOTH the browser (entitlement hooks,
// paywall UI) and the Express server (server-side enforcement). Keep this file
// free of any node-only or browser-only APIs — it is a plain data module.
//
// NOTE ON Infinity: `JSON.stringify(Infinity)` => `null`. Any API that ships
// limits to the client must serialize Infinity as the sentinel below and the
// client must map it back. Use `isUnlimited()` / `serializeLimit()` helpers.

export const PLAN_ORDER = ['free', 'pro', 'max']

export const UNLIMITED = 'unlimited' // wire sentinel for Infinity

export const TIERS = {
    free: {
        price: { monthly: 0, yearly: 0 },
        limits: {
            dsa_catalog_visible: 10,
            lld_catalog_visible: 3,
            hld_catalog_access: 'list_only',
            hld_practice_per_month: 0,       // "No HLD" — browse the list, no practice
            jobs_visible: 5,
            interview_q_per_subcategory: 5,
            resume_optimizer_per_month: 0,   // locked — Pro/Max only
            ai_explanations_per_month: 5,
            referral_requests_per_month: 0,  // locked — Pro/Max only
            company_subscriptions_max: 0,    // locked — Pro/Max only (job-alert subscriptions)
        },
    },
    pro: {
        // Billed for non-India users (see lib/geo.js's currencyForCountry) —
        // no longer "display only". Yearly = 10x monthly (2 months free),
        // matching the INR yearly discount.
        price: { monthly: 499, yearly: 4990 }, // cents, USD: $4.99/mo, $49.90/yr
        // Razorpay charges in paise (INR). Billed for India (and unknown —
        // the safe default) users.
        price_inr: { monthly: 19900, yearly: 199000 }, // ₹199/mo, ₹1,990/yr
        limits: {
            dsa_catalog_visible: Infinity,
            lld_catalog_visible: Infinity,
            hld_catalog_access: 'full',
            hld_practice_per_month: 5,
            jobs_visible: Infinity,
            interview_q_per_subcategory: Infinity,
            resume_optimizer_per_month: 5,   // job-specific resume optimizations / mo
            ai_explanations_per_month: 50,
            referral_requests_per_month: 10,
            company_subscriptions_max: 4,    // persistent count-cap, NOT monthly-metered
        },
    },
    max: {
        // Billed for non-India users — yearly = 10x monthly, same discount as Pro.
        price: { monthly: 899, yearly: 8990 }, // cents, USD: $8.99/mo, $89.90/yr
        price_inr: { monthly: 59900, yearly: 599000 }, // ₹599/mo, ₹5,990/yr
        limits: {
            dsa_catalog_visible: Infinity,
            lld_catalog_visible: Infinity,
            hld_catalog_access: 'full',
            hld_practice_per_month: Infinity,
            jobs_visible: Infinity,
            interview_q_per_subcategory: Infinity,
            resume_optimizer_per_month: Infinity,
            ai_explanations_per_month: 300, // soft cap, abuse protection only
            referral_requests_per_month: Infinity,
            // Deliberately finite (unlike most Max limits above) — product
            // spec caps Max at 10 company subscriptions, not unlimited.
            company_subscriptions_max: 10,
        },
    },
}

// ── Feature keys that meter monthly usage (need the `usage` table) ───
// Keep in sync with the CHECK constraint on public.usage.feature.
export const METERED_FEATURES = ['hld_practice', 'resume_optimizer', 'ai_explanation', 'referral_request']

// Map a metered feature key -> its per-month limit key in TIERS.limits
export const USAGE_LIMIT_KEY = {
    hld_practice: 'hld_practice_per_month',
    resume_optimizer: 'resume_optimizer_per_month',
    ai_explanation: 'ai_explanations_per_month',
    referral_request: 'referral_requests_per_month',
}

export const BILLING_PERIODS = ['monthly', 'yearly']

// ── Helpers (config-driven; never hard-code plan names elsewhere) ────
export function isValidPlan(plan) {
    return PLAN_ORDER.includes(plan)
}

// Amount Razorpay should charge, in paise. 0 for a plan with no INR price
// (e.g. free). period must be 'monthly' | 'yearly'.
export function priceInrPaise(plan, period) {
    const p = TIERS[plan] && TIERS[plan].price_inr
    if (!p) return 0
    const v = period === 'yearly' ? p.yearly : p.monthly
    return Number.isFinite(v) ? v : 0
}

// Amount Razorpay should charge, in cents, for a non-India (USD) checkout.
// 0 for a plan with no USD price (e.g. free). period must be 'monthly' | 'yearly'.
export function priceUsdCents(plan, period) {
    const p = TIERS[plan] && TIERS[plan].price
    if (!p) return 0
    const v = period === 'yearly' ? p.yearly : p.monthly
    return Number.isFinite(v) ? v : 0
}

export function planLimits(plan) {
    return (TIERS[plan] || TIERS.free).limits
}

export function getLimit(plan, limitKey) {
    const l = planLimits(plan)
    return limitKey in l ? l[limitKey] : undefined
}

export function isUnlimited(value) {
    return value === Infinity || value === UNLIMITED
}

// For API payloads: Infinity -> UNLIMITED sentinel, everything else unchanged.
export function serializeLimit(value) {
    return value === Infinity ? UNLIMITED : value
}

// For client parsing: UNLIMITED sentinel -> Infinity.
export function deserializeLimit(value) {
    return value === UNLIMITED ? Infinity : value
}

// ── AutoApply (paid packs of automated job applications) ─────────────
// Contract: docs/autoapply-contract.md. The Python scheduler/workers read the
// same numbers from env or cloud_hunter/saas/config.json — keep them in sync.
export const AUTO_APPLY = {
    plans: ['pro', 'max'],                // active Pro/Max required to buy
    monthly_cap: 1000,                    // applications per account per IST calendar month (purchase + claim checks)
    daily_cap: 60,                        // applied per user per IST day
    per_company_7d: 3,                    // applied per user per company_key in rolling 7 days
    window_days_max: 30, window_days_default: 30,   // job posting age the user may choose (1..30)
    credit_validity_days: 90,
    review_hours: 6,                      // shortlist review window when review_before_apply = true
    tenant_daily_cap_default: 150,        // platform-wide submissions per tenant_host per IST day
    packs: {                              // paise, GST inclusive
        service: { 50: 59900, 100: 115000 },
        product: { 50: 89900, 100: 149900 },   // confirmed 2026-11-20 (80 packs removed)
    },
}

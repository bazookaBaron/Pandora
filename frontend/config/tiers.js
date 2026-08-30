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
            hld_practice_per_month: 0,
            interview_q_per_subcategory: 5,
            resume_optimizer_per_month: 0,
            ai_explanations_per_month: 5,
            referral_requests_per_month: 0,
        },
    },
    pro: {
        price: { monthly: 900, yearly: 7900 }, // cents, USD — $9/mo, $79/yr
        limits: {
            dsa_catalog_visible: Infinity,
            lld_catalog_visible: Infinity,
            hld_catalog_access: 'full',
            hld_practice_per_month: 5,
            interview_q_per_subcategory: 5,
            resume_optimizer_per_month: 5,
            ai_explanations_per_month: 50,
            referral_requests_per_month: 5,
        },
    },
    max: {
        price: { monthly: 1900, yearly: 17900 }, // $19/mo, $179/yr
        limits: {
            dsa_catalog_visible: Infinity,
            lld_catalog_visible: Infinity,
            hld_catalog_access: 'full',
            hld_practice_per_month: Infinity,
            interview_q_per_subcategory: Infinity,
            resume_optimizer_per_month: 25, // soft cap, abuse protection only —
            ai_explanations_per_month: 300, // never shown to the user as a "limit"
            referral_requests_per_month: 20,
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

// ── Helpers (config-driven; never hard-code plan names elsewhere) ────
export function isValidPlan(plan) {
    return PLAN_ORDER.includes(plan)
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

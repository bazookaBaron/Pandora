// ── Analytics (PostHog) ─────────────────────────────────────────────
// One thin wrapper. Rules:
//  • DORMANT-SAFE: with no VITE_POSTHOG_KEY the whole module is a no-op —
//    nothing loads, nothing throws. Wire the key later and it just works.
//  • MEANINGFUL EVENTS ONLY. Use EVENTS.* — `track()` warns (dev) on unknown
//    names so we don't drift into click-tracking everything.
//  • NEVER send sensitive data. `track()` strips denylisted keys and truncates
//    long strings before they leave the browser. Do not pass resume text, JD
//    text, code, answers, passwords, tokens, or emails in event properties.

import posthog from 'posthog-js'

export const EVENTS = {
    SIGNUP: 'signup',
    LOGIN: 'login',
    GOOGLE_LOGIN: 'google_login',
    QUESTION_STARTED: 'question_started',
    QUESTION_COMPLETED: 'question_completed',
    SOLUTION_VIEWED: 'solution_viewed',
    AI_EXPLANATION_USED: 'ai_explanation_used',
    RESUME_OPTIMIZER_STARTED: 'resume_optimizer_started',
    RESUME_OPTIMIZER_COMPLETED: 'resume_optimizer_completed',
    PRICING_VIEWED: 'pricing_viewed',
    CHECKOUT_STARTED: 'checkout_started',
    CHECKOUT_COMPLETED: 'checkout_completed',
    REFERRAL_REQUEST_POSTED: 'referral_request_posted',
}

const ALLOWED = new Set(Object.values(EVENTS))

// Property keys we will never forward, even if a caller passes them by mistake.
const DENY_KEY = /(pass|pwd|token|secret|api[_-]?key|auth|resume|jd|job[_-]?desc|cover[_-]?letter|content|code|answer|prompt|email|phone|full[_-]?name|address)/i
const MAX_STR = 500

const KEY = import.meta.env.VITE_POSTHOG_KEY
const HOST = import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com'
const DEV = import.meta.env.DEV

let ready = false

export function initAnalytics() {
    if (ready || !KEY) return
    try {
        posthog.init(KEY, {
            api_host: HOST,
            capture_pageview: false,      // we send pricing_viewed etc. explicitly
            capture_pageleave: true,
            autocapture: false,           // meaningful events only
            disable_session_recording: true,
            person_profiles: 'identified_only',
            loaded: () => { ready = true },
        })
        ready = true
    } catch (e) {
        if (DEV) console.warn('[analytics] init failed', e)
    }
}

export function isEnabled() {
    return ready && !!KEY
}

// Tie events to the Supabase user id. `traits` is optional and MUST NOT contain
// PII — pass non-sensitive facts only (e.g. { plan: 'pro' }).
export function identifyUser(userId, traits) {
    if (!isEnabled() || !userId) return
    try {
        posthog.identify(String(userId), sanitize(traits))
    } catch (e) {
        if (DEV) console.warn('[analytics] identify failed', e)
    }
}

export function resetAnalytics() {
    if (!isEnabled()) return
    try { posthog.reset() } catch { /* ignore */ }
}

export function track(event, properties) {
    if (!ALLOWED.has(event)) {
        if (DEV) console.warn(`[analytics] ignored unknown event "${event}" — add it to EVENTS if intentional`)
        return
    }
    if (!isEnabled()) return
    try {
        posthog.capture(event, sanitize(properties))
    } catch (e) {
        if (DEV) console.warn('[analytics] capture failed', e)
    }
}

// Manual pageview helper for the router (only where a page-level event isn't
// already firing something more specific).
export function trackPageview() {
    if (!isEnabled()) return
    // No property override: posthog-js reads the full current URL itself, so
    // $host / $pathname / referrer stay correct for web-analytics reports.
    try { posthog.capture('$pageview') } catch { /* ignore */ }
}

// ── internal ────────────────────────────────────────────────────────
function sanitize(obj) {
    if (!obj || typeof obj !== 'object') return undefined
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
        if (DENY_KEY.test(k)) continue
        if (v == null) continue
        if (typeof v === 'string') out[k] = v.length > MAX_STR ? v.slice(0, MAX_STR) : v
        else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
        else if (Array.isArray(v)) out[k] = v.slice(0, 20).map(x => (typeof x === 'string' ? x.slice(0, 100) : x))
        // objects are dropped — keep event props flat and safe
    }
    return out
}

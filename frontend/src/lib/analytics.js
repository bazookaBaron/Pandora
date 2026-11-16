// ── Analytics (PostHog) ─────────────────────────────────────────────
// One thin wrapper. Rules:
//  • DORMANT-SAFE: with no VITE_POSTHOG_KEY the whole module is a no-op —
//    nothing loads, nothing throws. Wire the key later and it just works.
//  • MEANINGFUL EVENTS ONLY. Use EVENTS.* — `track()` warns (dev) on unknown
//    names so we don't drift into click-tracking everything.
//  • NEVER send sensitive data. `track()` strips denylisted keys and truncates
//    long strings before they leave the browser. Do not pass resume text, JD
//    text, code, answers, passwords, tokens, or emails in event properties.

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

// posthog-js (~100KB+) is loaded lazily via dynamic import after the browser is
// idle, and only when a key is configured. Calls made before it finishes
// loading are queued (bounded) and replayed once ready.
let ready = false
let initStarted = false
let ph = null
const MAX_QUEUE = 100
let queue = []

function enqueue(fn) {
    if (!KEY) return
    if (queue.length >= MAX_QUEUE) queue.shift()
    queue.push(fn)
}

function whenIdle(cb) {
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(cb, { timeout: 4000 })
    } else {
        setTimeout(cb, 1500)
    }
}

export function initAnalytics() {
    if (initStarted || !KEY) return
    initStarted = true
    whenIdle(async () => {
        try {
            const mod = await import('posthog-js')
            const posthog = mod.default || mod.posthog
            posthog.init(KEY, {
                api_host: HOST,
                capture_pageview: false,      // we send pricing_viewed etc. explicitly
                capture_pageleave: true,
                autocapture: false,           // meaningful events only
                disable_session_recording: true,
                person_profiles: 'identified_only',
            })
            ph = posthog
            ready = true
            const pending = queue
            queue = []
            for (const fn of pending) {
                try { fn(posthog) } catch (e) { if (DEV) console.warn('[analytics] queued call failed', e) }
            }
        } catch (e) {
            queue = []
            if (DEV) console.warn('[analytics] init failed', e)
        }
    })
}

export function isEnabled() {
    return ready && !!KEY
}

// Tie events to the Supabase user id. `traits` is optional and MUST NOT contain
// PII — pass non-sensitive facts only (e.g. { plan: 'pro' }).
export function identifyUser(userId, traits) {
    if (!KEY || !userId) return
    const props = sanitize(traits)
    const run = (p) => p.identify(String(userId), props)
    if (!ready) return enqueue(run)
    try { run(ph) } catch (e) { if (DEV) console.warn('[analytics] identify failed', e) }
}

export function resetAnalytics() {
    if (!KEY) return
    if (!ready) { queue = []; return }   // nothing identified yet; drop queued identify/capture
    try { ph.reset() } catch { /* ignore */ }
}

export function track(event, properties) {
    if (!ALLOWED.has(event)) {
        if (DEV) console.warn(`[analytics] ignored unknown event "${event}" — add it to EVENTS if intentional`)
        return
    }
    if (!KEY) return
    const props = sanitize(properties)
    const run = (p) => p.capture(event, props)
    if (!ready) return enqueue(run)
    try { run(ph) } catch (e) { if (DEV) console.warn('[analytics] capture failed', e) }
}

// Manual pageview helper for the router (only where a page-level event isn't
// already firing something more specific).
export function trackPageview() {
    if (!KEY) return
    // No property override: posthog-js reads the full current URL itself, so
    // $host / $pathname / referrer stay correct for web-analytics reports.
    const run = (p) => p.capture('$pageview')
    if (!ready) return enqueue(run)
    try { run(ph) } catch { /* ignore */ }
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

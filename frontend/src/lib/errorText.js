// ── errorText(err) ──────────────────────────────────────────────────
// One normaliser for every error shape the UI can see, so toasts and inline
// messages never print "[object Object]" or a bare code:
//   • ApiError from apiFetch ({ code, message, body })
//   • AutoApply bodies  { error: { code, message } }
//   • legacy bodies     { error: 'code' }   (optionally with message)
//   • Error / DOMException (AbortError), plain strings, null
const FRIENDLY = {
    network: 'Network error. Check your connection and try again.',
    timeout: 'The server took too long to respond. Please try again.',
    'auth required': 'Please sign in again.',
    unauthorized: 'Please sign in again.',
    usage_limit: 'You have reached your plan limit.',
    upgrade_required: 'This needs a paid plan.',
    rate_limited: 'Too many requests. Wait a moment and try again.',
    too_many_requests: 'Too many requests. Wait a moment and try again.',
    not_found: 'Not found.',
    forbidden: 'You do not have access to this.',
    reauth_required: 'For your security, sign in again to continue.',
    consent_required: 'Accept the AutoApply terms in Setup first.',
    endpoint_owned: 'This device already gets notifications for another account. Turn them off there first.',
}

// snake_case machine codes ("invalid_state") → "Invalid state"
const isSnakeCode = (s) => /^[a-z0-9]+(_[a-z0-9]+)+$/.test(s)

function fromString(s, fallback) {
    const t = String(s || '').trim()
    if (!t) return fallback
    if (FRIENDLY[t]) return FRIENDLY[t]
    if (isSnakeCode(t)) return t.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
    return t
}

export function errorText(err, fallback = 'Something went wrong. Please try again.') {
    if (err == null) return fallback
    if (typeof err === 'string') return fromString(err, fallback)
    if (typeof err !== 'object') return fallback
    if (err.name === 'AbortError') return FRIENDLY.timeout

    // Body-shaped error: the response body itself, or an error carrying one.
    const body = err.body && typeof err.body === 'object' ? err.body : (err.error !== undefined ? err : null)
    if (body) {
        const e = body.error
        if (e && typeof e === 'object') {
            if (e.message) return String(e.message)
            if (e.code) return fromString(e.code, fallback)
        }
        if (typeof e === 'string' && e) {
            if (typeof body.message === 'string' && body.message.trim()) return body.message.trim()
            return fromString(e, fallback)
        }
        if (typeof body.message === 'string' && body.message.trim()) return body.message.trim()
    }

    if (err.code && FRIENDLY[err.code] && (!err.message || err.message === err.code)) return FRIENDLY[err.code]
    if (typeof err.message === 'string' && err.message) return fromString(err.message, fallback)
    return fallback
}

export default errorText

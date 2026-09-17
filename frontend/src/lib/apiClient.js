import { supabase } from './supabase'

// ── Typed API error ─────────────────────────────────────────────────
// Every non-2xx response from the Express API (proxied at /api) is turned
// into one of these. `code` mirrors the JSON `error` string the server
// sends ('auth required' | 'usage_limit' | 'upgrade_required' | …).
// A network failure surfaces as `{ status: 0, code: 'network' }`.
export class ApiError extends Error {
    constructor(message, { status = 0, code = null, feature = null, used = null, limit = null, resetsAt = null, body = null } = {}) {
        super(message || code || 'Request failed')
        this.name = 'ApiError'
        this.status = status
        this.code = code
        this.feature = feature
        this.used = used
        this.limit = limit
        this.resetsAt = resetsAt
        this.body = body
    }
}

// True for the two "you can't do this until you upgrade" shapes.
export function isUsageLimit(err) {
    return err instanceof ApiError && (err.code === 'usage_limit' || err.code === 'upgrade_required')
}

async function getAccessToken() {
    try {
        const { data } = await supabase.auth.getSession()
        return data?.session?.access_token || null
    } catch {
        return null
    }
}

// Shared across concurrent 401s so a burst of stale-token requests triggers a
// single refresh, not one per request. Reset once it settles.
let refreshPromise = null
function refreshSessionOnce() {
    if (!refreshPromise) {
        refreshPromise = supabase.auth.refreshSession()
            .catch(() => ({ data: { session: null } }))
            .finally(() => { refreshPromise = null })
    }
    return refreshPromise
}

// A retried request still 401ing means the session is genuinely dead
// server-side, not a slow client — this used to only fire a UI event
// (SessionExpiredBanner) without ever actually clearing the local session,
// so AuthContext's `session` stayed truthy, ProtectedRoute never
// re-evaluated, and a protected page (e.g. Profile) kept rendering fully —
// stale cached data, editable forms, a clickable Save button — even though
// every one of those actions would now silently 401. Actually signing out
// locally makes AuthContext's SIGNED_OUT handling (clear query cache,
// navigate to /auth) run for real, same as a deliberate logout.
// Deduped so a burst of concurrent 401s doesn't fire signOut() N times.
let signOutInFlight = false
function emitAuthExpired() {
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('auth:expired'))
    }
    if (!signOutInFlight) {
        signOutInFlight = true
        supabase.auth.signOut().finally(() => { signOutInFlight = false })
    }
}

// ── apiFetch(path, opts) ────────────────────────────────────────────
//   opts: { method, json, formData, headers, signal }
//   • Attaches `Authorization: Bearer <supabase token>` when a session exists
//     (still sends without one — the server answers 401).
//   • `json`      → JSON.stringify + Content-Type: application/json
//   • `formData`  → sent as-is (browser sets the multipart boundary)
//   • method defaults to GET, or POST when a body (json/formData) is given.
//   • Returns the parsed JSON body (null for an empty body).
//   • Throws `ApiError` on !res.ok or on a network failure.
export async function apiFetch(path, opts = {}) {
    const { json, formData, headers = {}, signal } = opts
    const method = opts.method || (json !== undefined || formData !== undefined ? 'POST' : 'GET')

    let body
    let contentType = null
    if (json !== undefined) {
        body = JSON.stringify(json)
        contentType = 'application/json'
    } else if (formData !== undefined) {
        body = formData
    }

    // One network round-trip with the given bearer token. Returns { res, parsed }
    // or throws an ApiError for a network failure.
    const send = async (token) => {
        const finalHeaders = { ...headers }
        if (token) finalHeaders.Authorization = `Bearer ${token}`
        if (contentType) finalHeaders['Content-Type'] = contentType

        let res
        try {
            res = await fetch(path, { method, headers: finalHeaders, body, signal })
        } catch (err) {
            if (err && err.name === 'AbortError') throw err
            throw new ApiError('Network request failed — is the API server running?', { status: 0, code: 'network' })
        }

        const text = await res.text()
        let parsed = null
        if (text) {
            try { parsed = JSON.parse(text) } catch { parsed = null }
        }
        return { res, parsed }
    }

    const initialToken = await getAccessToken()
    let { res, parsed } = await send(initialToken)

    // 401 while we *did* send a token → the token is stale/expired (not a
    // never-logged-in call). Refresh once (shared across concurrent 401s) and
    // retry the original request a single time. If it still 401s — or the
    // refresh yields nothing / the same token — emit a global 'auth:expired'
    // signal so the app can prompt a re-login, then fall through to the throw.
    if (res.status === 401 && initialToken) {
        let newToken = null
        try {
            const { data } = await refreshSessionOnce()
            newToken = data?.session?.access_token || null
        } catch {
            newToken = null
        }

        if (newToken && newToken !== initialToken) {
            ;({ res, parsed } = await send(newToken))
        }

        if (res.status === 401) emitAuthExpired()
    }

    if (!res.ok) {
        const code = (parsed && parsed.error) || null
        throw new ApiError(code || `Request failed (${res.status})`, {
            status: res.status,
            code,
            feature: parsed ? parsed.feature ?? null : null,
            used: parsed ? parsed.used ?? null : null,
            limit: parsed ? parsed.limit ?? null : null,
            resetsAt: parsed ? parsed.resetsAt ?? null : null,
            body: parsed,
        })
    }

    return parsed
}

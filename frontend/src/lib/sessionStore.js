// Guarded sessionStorage helpers. Access can throw in private-browsing
// modes or when storage is disabled, so every call is wrapped.

export function ssGet(key) {
    try {
        return sessionStorage.getItem(key)
    } catch {
        return null
    }
}

export function ssSet(key, val) {
    try {
        if (val) sessionStorage.setItem(key, val)
        else sessionStorage.removeItem(key)
    } catch {
        // storage unavailable — silently ignore
    }
}

// Remove every sessionStorage entry whose key starts with `prefix`.
// Used on sign-out to drop per-user UI state (e.g. 'iq:*').
export function ssClearPrefix(prefix) {
    try {
        const doomed = []
        for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i)
            if (key && key.startsWith(prefix)) doomed.push(key)
        }
        for (const key of doomed) {
            try {
                sessionStorage.removeItem(key)
            } catch {
                // ignore a single failed removal
            }
        }
    } catch {
        // storage unavailable — silently ignore
    }
}

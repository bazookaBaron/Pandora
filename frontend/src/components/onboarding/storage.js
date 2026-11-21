// localStorage helpers for per-viewer onboarding conveniences. Storage can be
// missing or throw (private mode, blocked site data), so every access is guarded
// and callers get a sane default.

export const WELCOME_KEY = 'vb_onboarded_v1'
export const OPEN_GUIDE_EVENT = 'vb:open-guide'

export function readFlag(key) {
    try {
        return window.localStorage.getItem(key)
    } catch {
        return null
    }
}

export function writeFlag(key, value) {
    try {
        if (value === null) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, String(value))
    } catch {
        // storage unavailable: the flag just won't persist
    }
}

export const welcomeKeyFor = (uid) => `${WELCOME_KEY}:${uid}`

/** Reopen the first-run welcome from anywhere (Navbar "Guide" link). */
export function openGuide() {
    try {
        window.dispatchEvent(new CustomEvent(OPEN_GUIDE_EVENT))
    } catch {
        // very old browsers: no-op
    }
}

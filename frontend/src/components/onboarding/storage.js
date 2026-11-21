// localStorage helpers for per-viewer onboarding conveniences. Storage can be
// missing or throw (private mode, blocked site data), so every access is guarded
// and callers get a sane default.

export const WELCOME_KEY = 'vb_onboarded_v1' // quick-setup finished/skipped (value 'setup-done')
export const TOUR_KEY = 'vb_tour_v1' // guided tour finished/skipped
export const GOALS_KEY = 'vb_goals_v1' // what the user is here for (orders tour emphasis only)

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
export const tourKeyFor = (uid) => `${TOUR_KEY}:${uid}`
export const goalsKeyFor = (uid) => `${GOALS_KEY}:${uid}`

export function readGoals(uid) {
    try {
        const v = JSON.parse(readFlag(goalsKeyFor(uid)) || '[]')
        return Array.isArray(v) ? v.filter((g) => typeof g === 'string') : []
    } catch {
        return []
    }
}

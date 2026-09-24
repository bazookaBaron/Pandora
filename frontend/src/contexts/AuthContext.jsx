import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { ssClearPrefix } from '../lib/sessionStore'
import { identifyUser, resetAnalytics } from '../lib/analytics'
import { apiFetch } from '../lib/apiClient'

const AuthContext = createContext(null)

const SIGN_OUT_TIMEOUT_MS = 5000

// Removes supabase-js's persisted session (and PKCE verifier / user copies)
// from localStorage so a reload can't restore it.
function clearStoredSession() {
    try {
        const key = supabase.auth.storageKey
        const keys = Object.keys(window.localStorage).filter(k =>
            (key && k.startsWith(key)) || /^sb-.+-auth-token/.test(k)
        )
        keys.forEach(k => window.localStorage.removeItem(k))
    } catch {
        // Storage unavailable (private mode / blocked) — nothing persisted to clear.
    }
}

export function AuthProvider({ children }) {
    const [session, setSession] = useState(undefined) // undefined = loading
    const queryClient = useQueryClient()
    const navigate = useNavigate()
    // Analytics: only identify once per user id per mount so a token refresh or
    // repeat SIGNED_IN doesn't re-fire identify on every event.
    const lastIdentifiedRef = useRef(null)
    // Same guard, for the geo-pricing country detection (server.js's
    // POST /api/profile/detect-country) — fires once per user id per mount;
    // the server side is also idempotent (no-ops once profiles.country is
    // set), so this is just avoiding a pointless repeat call on every token
    // refresh, not a correctness requirement.
    const lastCountryCheckRef = useRef(null)

    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session)
        })

        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            setSession(session)

            // Tie analytics events to the Supabase user id whenever a session is
            // present. Guarded so it fires once per user id, not on every token
            // refresh. No PII — just the id.
            if (session?.user?.id && lastIdentifiedRef.current !== session.user.id) {
                lastIdentifiedRef.current = session.user.id
                identifyUser(session.user.id)
            }

            if (session?.user?.id && lastCountryCheckRef.current !== session.user.id) {
                lastCountryCheckRef.current = session.user.id
                apiFetch('/api/profile/detect-country', { method: 'POST' }).catch(() => {
                    // Best-effort — a failed detection just leaves country
                    // null, which currencyForCountry() already treats as
                    // India (the safe default), so there's nothing to
                    // recover from here.
                })
            }

            // Only a real sign-out should wipe cached data + per-user UI state.
            // supabase-js v2 also fires INITIAL_SESSION (possibly null) on cold
            // load and TOKEN_REFRESHED / USER_UPDATED / SIGNED_IN during a
            // normal session — none of those should clear anything.
            if (event === 'SIGNED_OUT') {
                clearUserState()
                navigate('/auth', { replace: true })
            }
        })

        return () => subscription.unsubscribe()
        // Effect subscribes once for the provider's lifetime. queryClient is a
        // stable singleton from context and navigate is stable in RRDv7, so
        // they never need to trigger a re-subscribe.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const clearUserState = () => {
        lastIdentifiedRef.current = null
        queryClient.clear()
        ssClearPrefix('iq:')
        resetAnalytics()
    }

    // supabase.auth.signOut() doesn't always clear the local session: if the
    // access token is expired and the refresh fails (offline, flaky network)
    // it returns an error early and keeps the stored session, and it can hang
    // waiting on the auth lock. Either way SIGNED_OUT never fires, `session`
    // stays truthy, and /auth bounces the user straight back to / — the
    // button looks dead. So on any failure, wipe the stored session ourselves
    // and hard-navigate to /auth, which boots a fresh client with no session.
    const logout = async () => {
        let ok = false
        try {
            const result = await Promise.race([
                supabase.auth.signOut(),
                new Promise(resolve => setTimeout(() => resolve({ error: new Error('signOut timed out') }), SIGN_OUT_TIMEOUT_MS)),
            ])
            ok = !result?.error
        } catch {
            ok = false
        }

        if (ok) {
            setSession(null)
            navigate('/auth', { replace: true })
            return
        }

        clearStoredSession()
        clearUserState()
        setSession(null)
        window.location.replace('/auth')
    }

    return (
        <AuthContext.Provider value={{ session, user: session?.user ?? null, loading: session === undefined, logout }}>
            {children}
        </AuthContext.Provider>
    )
}

export function useAuth() {
    return useContext(AuthContext)
}

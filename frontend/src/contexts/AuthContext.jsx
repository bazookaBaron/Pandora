import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { ssClearPrefix } from '../lib/sessionStore'
import { identifyUser, resetAnalytics } from '../lib/analytics'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
    const [session, setSession] = useState(undefined) // undefined = loading
    const queryClient = useQueryClient()
    const navigate = useNavigate()
    // Analytics: only identify once per user id per mount so a token refresh or
    // repeat SIGNED_IN doesn't re-fire identify on every event.
    const lastIdentifiedRef = useRef(null)

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

            // Only a real sign-out should wipe cached data + per-user UI state.
            // supabase-js v2 also fires INITIAL_SESSION (possibly null) on cold
            // load and TOKEN_REFRESHED / USER_UPDATED / SIGNED_IN during a
            // normal session — none of those should clear anything.
            if (event === 'SIGNED_OUT') {
                lastIdentifiedRef.current = null
                queryClient.clear()
                ssClearPrefix('iq:')
                resetAnalytics()
                navigate('/auth', { replace: true })
            }
        })

        return () => subscription.unsubscribe()
        // Effect subscribes once for the provider's lifetime. queryClient is a
        // stable singleton from context and navigate is stable in RRDv7, so
        // they never need to trigger a re-subscribe.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const logout = async () => {
        await supabase.auth.signOut()
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

import { createContext, useContext, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { ssClearPrefix } from '../lib/sessionStore'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
    const [session, setSession] = useState(undefined) // undefined = loading
    const queryClient = useQueryClient()
    const navigate = useNavigate()

    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session)
        })

        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            setSession(session)

            // Only a real sign-out should wipe cached data + per-user UI state.
            // supabase-js v2 also fires INITIAL_SESSION (possibly null) on cold
            // load and TOKEN_REFRESHED / USER_UPDATED / SIGNED_IN during a
            // normal session — none of those should clear anything.
            if (event === 'SIGNED_OUT') {
                queryClient.clear()
                ssClearPrefix('iq:')
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

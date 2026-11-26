import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { readFlag, welcomeKeyFor, writeFlag } from './storage'

// QuickSetup (and its CSS) is a separate chunk, fetched only when about to show.
// WS-M0: the multi-step GuidedTour is retired (replaced by the first-visit picker,
// FirstVisitPicker.jsx, plus one HelpChip per page). GuidedTour.jsx is no longer
// imported anywhere and can be deleted together with its CSS.
const QuickSetup = lazy(() => import('./QuickSetup'))

// Only accounts created recently get the automatic first run.
const NEW_ACCOUNT_MS = 14 * 24 * 3600 * 1000
// Routes where an automatic overlay would be in the way.
const QUIET_ROUTES = /^\/(auth|terms|privacy|refunds|contact|legal|subscription)(\/|$)/
const SETUP_DONE = 'setup-done'

function isNewAccount(user) {
    const t = Date.parse(user?.created_at || '')
    return Number.isFinite(t) && Date.now() - t < NEW_ACCOUNT_MS
}

/**
 * Mounted once in App (inside AuthProvider + Router). Renders nothing for
 * logged-out visitors. New account (<14d) + no setup flag -> quick setup (once,
 * persisted per-uid in localStorage).
 */
export default function FirstRunHost() {
    const { user } = useAuth() || {}
    const { pathname } = useLocation()
    const uid = user?.id || null
    const [phase, setPhase] = useState(null) // null | 'setup'

    useEffect(() => {
        if (!uid) { setPhase(null); return }
        if (phase || QUIET_ROUTES.test(pathname) || !isNewAccount(user)) return
        const setup = readFlag(welcomeKeyFor(uid))
        if (!setup) {
            // A second browser: the profile may already be filled in. Skip
            // QuickSetup so it can't re-ask or overwrite.
            let cancelled = false
            ;(async () => {
                let hasPosition = false
                try {
                    const { data } = await supabase.from('profiles').select('position').eq('id', uid).maybeSingle()
                    hasPosition = !!(data && String(data.position || '').trim())
                } catch { /* offline: fall back to showing setup */ }
                if (cancelled) return
                if (hasPosition) {
                    writeFlag(welcomeKeyFor(uid), SETUP_DONE)
                    setPhase(null)
                } else setPhase('setup')
            })()
            return () => { cancelled = true }
        }
    }, [uid, pathname]) // eslint-disable-line react-hooks/exhaustive-deps

    const finishSetup = useCallback(() => {
        if (!uid) return
        writeFlag(welcomeKeyFor(uid), SETUP_DONE)
        setPhase(null)
    }, [uid])

    if (!uid || phase !== 'setup') return null
    return (
        <Suspense fallback={null}>
            <QuickSetup uid={uid} onFinish={finishSetup} />
        </Suspense>
    )
}

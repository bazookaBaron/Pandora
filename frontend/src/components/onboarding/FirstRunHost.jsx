import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { readFlag, tourKeyFor, welcomeKeyFor, writeFlag } from './storage'

// Both pieces (and their CSS) are separate chunks, fetched only when about to show.
const QuickSetup = lazy(() => import('./QuickSetup'))
const GuidedTour = lazy(() => import('./GuidedTour'))

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
 * logged-out visitors. New account (<14d) + no setup flag -> quick setup, then
 * the guided tour (once). Both persist per-uid in localStorage.
 */
export default function FirstRunHost() {
    const { user } = useAuth() || {}
    const { pathname } = useLocation()
    const uid = user?.id || null
    const [phase, setPhase] = useState(null) // null | 'setup' | 'tour'

    useEffect(() => {
        if (!uid) { setPhase(null); return }
        if (phase || QUIET_ROUTES.test(pathname) || !isNewAccount(user)) return
        const setup = readFlag(welcomeKeyFor(uid))
        if (!setup) setPhase('setup')
        // setup finished but the tour was interrupted (reload): resume it
        else if (setup === SETUP_DONE && !readFlag(tourKeyFor(uid))) setPhase('tour')
    }, [uid, pathname]) // eslint-disable-line react-hooks/exhaustive-deps

    const finishSetup = useCallback((withTour = true) => {
        if (!uid) return
        writeFlag(welcomeKeyFor(uid), SETUP_DONE)
        if (!withTour) writeFlag(tourKeyFor(uid), 'skipped')
        setPhase(withTour && !readFlag(tourKeyFor(uid)) ? 'tour' : null)
    }, [uid])

    const finishTour = useCallback(() => {
        if (uid) writeFlag(tourKeyFor(uid), new Date().toISOString())
        setPhase(null)
    }, [uid])

    if (!uid || !phase) return null
    return (
        <Suspense fallback={null}>
            {phase === 'setup'
                ? <QuickSetup uid={uid} onFinish={finishSetup} />
                : <GuidedTour uid={uid} onClose={finishTour} />}
        </Suspense>
    )
}

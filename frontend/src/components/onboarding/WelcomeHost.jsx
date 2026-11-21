import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { OPEN_GUIDE_EVENT, openGuide, readFlag, welcomeKeyFor, writeFlag } from './storage'

// The modal (and its CSS) is a separate chunk, fetched only when it is about to show.
const WelcomeModal = lazy(() => import('./WelcomeModal'))

// Only accounts created recently get the automatic first-run welcome; older accounts
// (before this shipped) can still open it from the "Guide" link.
const NEW_ACCOUNT_MS = 14 * 24 * 3600 * 1000
// Routes where an automatic popup would be in the way.
const QUIET_ROUTES = /^\/(auth|terms|privacy|refunds|contact|legal|subscription)(\/|$)/

function isNewAccount(user) {
    const t = Date.parse(user?.created_at || '')
    return Number.isFinite(t) && Date.now() - t < NEW_ACCOUNT_MS
}

/** Mounted once in App (inside AuthProvider + Router). */
export default function WelcomeHost() {
    const { user } = useAuth() || {}
    const { pathname } = useLocation()
    const uid = user?.id || null
    const [open, setOpen] = useState(false)

    // first run: no flag for this user yet
    useEffect(() => {
        if (!uid || open || QUIET_ROUTES.test(pathname)) return
        if (readFlag(welcomeKeyFor(uid))) return
        if (isNewAccount(user)) setOpen(true)
    }, [uid, pathname]) // eslint-disable-line react-hooks/exhaustive-deps

    // reopen from the Guide link
    useEffect(() => {
        const onOpen = () => setOpen(true)
        window.addEventListener(OPEN_GUIDE_EVENT, onOpen)
        return () => window.removeEventListener(OPEN_GUIDE_EVENT, onOpen)
    }, [])

    const close = useCallback(() => {
        if (uid) writeFlag(welcomeKeyFor(uid), new Date().toISOString())
        setOpen(false)
    }, [uid])

    if (!open) return null
    return (
        <Suspense fallback={null}>
            <WelcomeModal onClose={close} signedIn={!!uid} />
        </Suspense>
    )
}

/** Small "Guide" link for the Navbar / menus: reopens the welcome. */
export function GuideLink({ className = 'nav-pill', style, onClick }) {
    return (
        <button
            type="button"
            className={className}
            style={style}
            onClick={(e) => { onClick?.(e); openGuide() }}
            aria-haspopup="dialog"
            title="Getting started guide"
        >
            Guide
        </button>
    )
}

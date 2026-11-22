import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../contexts/ThemeContext'
import { useAvatarUrl } from '../lib/useAvatar'
import { useMediaQuery } from '../lib/useMediaQuery'

function ThemeToggle({ full = false }) {
    const { theme, toggleTheme } = useTheme()
    const isDark = theme === 'dark'
    return (
        <button
            type="button"
            className="nav-pill"
            data-tour="theme"
            onClick={toggleTheme}
            aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
            title={isDark ? 'Light theme' : 'Dark theme'}
            style={full ? { width: '100%', justifyContent: 'flex-start' } : { padding: '6px 9px' }}
        >
            {isDark ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
                </svg>
            ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
            )}
            {full && <span>{isDark ? 'Light theme' : 'Dark theme'}</span>}
        </button>
    )
}

function getInitials(user) {
    const name =
        user?.user_metadata?.full_name ||
        user?.user_metadata?.name ||
        user?.email?.split('@')[0] ||
        'U'
    const parts = name.split(' ').filter(Boolean)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return name.slice(0, 2).toUpperCase()
}

function stringToColor(str = '') {
    let hash = 0
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash)
    const colors = ['#22d3ee', '#f472b6', '#4ade80', '#facc15', '#a78bfa', '#fb923c', '#60a5fa']
    return colors[Math.abs(hash) % colors.length]
}

// Shown once VITE_AUTOAPPLY=1 at build time; the /autoapply pages still work by direct link for testing.
const AUTOAPPLY_LINK = import.meta.env.VITE_AUTOAPPLY === '1' ? [{ to: '/autoapply', label: 'Auto Apply' }] : []

// Always-visible top level: Jobs, Auto Apply, Referrals. Everything else lives under "Prep".
const MAIN_LINKS = [
    { to: '/', label: 'Jobs' },
    ...AUTOAPPLY_LINK,
    { to: '/referrals', label: 'Referrals' },
]
const PREP_LINKS = [
    { to: '/dsa', label: 'DSA' },
    { to: '/lld', label: 'LLD' },
    { to: '/hld', label: 'HLD' },
    { to: '/interview', label: 'Interview Questions' },
    { to: '/optimizer', label: 'Resume Optimizer' },
]

// data-tour anchors for the first-run guided tour (see onboarding/GuidedTour.jsx)
const tourId = (to) => ({ '/': 'jobs', '/autoapply': 'autoapply', '/referrals': 'referrals', '/dsa': 'dsa', '/lld': 'lld', '/hld': 'hld' })[to]

function PrepMenu({ isActive, pathname }) {
    const [open, setOpen] = useState(false)
    const boxRef = useRef(null)
    const btnRef = useRef(null)
    const anyActive = PREP_LINKS.some(l => isActive(l.to))

    useEffect(() => { setOpen(false) }, [pathname])
    useEffect(() => {
        if (!open) return
        const onPointer = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
        const onKey = (e) => {
            if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus() }
        }
        document.addEventListener('mousedown', onPointer)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onPointer)
            document.removeEventListener('keydown', onKey)
        }
    }, [open])

    return (
        <div className="prep-menu" ref={boxRef}>
            <button
                ref={btnRef}
                type="button"
                data-tour="prep"
                className={'nav-pill' + (anyActive ? ' active' : '')}
                aria-haspopup="true"
                aria-expanded={open}
                onClick={() => setOpen(v => !v)}
            >
                Prep
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M6 9l6 6 6-6" />
                </svg>
            </button>
            {open && (
                <div className="prep-menu-list" role="menu" aria-label="Prep">
                    {PREP_LINKS.map(link => (
                        <Link
                            key={link.to}
                            to={link.to}
                            role="menuitem"
                            data-tour={tourId(link.to)}
                            onClick={() => setOpen(false)}
                            className={'prep-menu-item' + (isActive(link.to) ? ' active' : '')}
                        >
                            {link.label}
                        </Link>
                    ))}
                </div>
            )}
        </div>
    )
}

function NavTabs({ isActive }) {
    return (
        <div className="nav-tabs" role="navigation" aria-label="Sections" style={{ '--tab-count': MAIN_LINKS.length }}>
            {MAIN_LINKS.map(link => (
                <Link
                    key={link.to}
                    to={link.to}
                    data-tour={tourId(link.to)}
                    aria-current={isActive(link.to) ? 'page' : undefined}
                    className={'nav-tab' + (isActive(link.to) ? ' active' : '')}
                >
                    {link.label}
                </Link>
            ))}
        </div>
    )
}

export default function Navbar() {
    const { user, logout } = useAuth()
    const location = useLocation()
    const isMobile = useMediaQuery('(max-width: 767px)')
    const [menuOpen, setMenuOpen] = useState(false)
    const navRef = useRef(null)
    // Full-height workspace screens on phones drop the tab row to keep room for the editor.
    const compact = isMobile && /^\/(lld|hld)\/[^/]+/.test(location.pathname)
    useEffect(() => {
        const el = document.documentElement
        if (compact) el.setAttribute('data-nav-compact', '')
        else el.removeAttribute('data-nav-compact')
        return () => el.removeAttribute('data-nav-compact')
    }, [compact])

    const [signingOut, setSigningOut] = useState(false)
    const handleLogout = async () => {
        if (signingOut) return
        // keep the menu open so the pending state is visible; it closes on the
        // route change to /auth
        setSigningOut(true)
        try {
            await logout()
        } finally {
            setSigningOut(false)
            setMenuOpen(false)
        }
    }

    const isActive = (to) => {
        if (to === '/') return location.pathname === '/'
        return location.pathname.startsWith(to)
    }

    // Close the mobile menu whenever the route changes.
    useEffect(() => { setMenuOpen(false) }, [location.pathname])

    // Drop the menu if we grow back to desktop while it's open.
    useEffect(() => { if (!isMobile) setMenuOpen(false) }, [isMobile])

    // Close on outside click / Escape while the sheet is open.
    useEffect(() => {
        if (!menuOpen) return
        const onPointer = (e) => {
            if (navRef.current && !navRef.current.contains(e.target)) setMenuOpen(false)
        }
        const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false) }
        document.addEventListener('mousedown', onPointer)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onPointer)
            document.removeEventListener('keydown', onKey)
        }
    }, [menuOpen])

    const profileLabel = user?.user_metadata?.full_name?.split(' ')[0] || user?.email?.split('@')[0] || 'Profile'
    const avatarUrl = useAvatarUrl()
    const avatar = avatarUrl ? (
        <img
            className="nav-avatar"
            src={avatarUrl}
            alt=""
            referrerPolicy="no-referrer"
            style={{ width: 18, height: 18, borderRadius: 3, objectFit: 'cover' }}
        />
    ) : (
        <span
            className="nav-avatar"
            style={{ background: stringToColor(user?.email), width: 18, height: 18, fontSize: '0.55rem', borderRadius: 3 }}
        >
            {getInitials(user)}
        </span>
    )

    return (
      <>
        <nav className="top-nav" ref={navRef}>
            <Link to="/" className="nav-brand">
                <img src="/vloombox-logo.svg" alt="" width="42" height="42" style={{ display: 'block' }} />
                VLOOMBOX
            </Link>

            {isMobile ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <ThemeToggle />
                    <button
                        type="button"
                        className="nav-pill"
                        aria-label="Menu"
                        data-tour="prep"
                        aria-expanded={menuOpen}
                        onClick={() => setMenuOpen(v => !v)}
                        style={{ padding: '6px 10px' }}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            {menuOpen ? (
                                <>
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                    <line x1="6" y1="18" x2="18" y2="6" />
                                </>
                            ) : (
                                <>
                                    <line x1="3" y1="6" x2="21" y2="6" />
                                    <line x1="3" y1="12" x2="21" y2="12" />
                                    <line x1="3" y1="18" x2="21" y2="18" />
                                </>
                            )}
                        </svg>
                    </button>
                  </div>

                    {menuOpen && (
                        <div
                            style={{
                                position: 'absolute', top: '100%', left: 0, right: 0,
                                background: 'var(--panel)',
                                borderTop: '1px solid var(--subtle)',
                                borderBottom: '1px solid var(--subtle)',
                                display: 'flex', flexDirection: 'column', gap: 4,
                                padding: 8,
                                animation: 'slideDown 0.2s ease both',
                            }}
                        >
                            <div className="mobile-prep-group" role="group" aria-label="Prep">
                                <div className="mobile-prep-title">Prep</div>
                                {PREP_LINKS.map(link => (
                                    <Link
                                        key={link.to}
                                        to={link.to}
                                        onClick={() => setMenuOpen(false)}
                                        className={`nav-pill${isActive(link.to) ? ' active' : ''}`}
                                        style={{ width: '100%', justifyContent: 'flex-start' }}
                                    >
                                        {link.label}
                                    </Link>
                                ))}
                            </div>

                            {user ? (
                                <>
                                    <Link
                                        to="/profile"
                                        data-tour="profile"
                                        onClick={() => setMenuOpen(false)}
                                        className={`nav-pill${isActive('/profile') ? ' active' : ''}`}
                                        style={{ width: '100%', justifyContent: 'flex-start' }}
                                    >
                                        {avatar}
                                        {profileLabel}
                                    </Link>

                                    <button
                                        type="button"
                                        onClick={handleLogout}
                                        disabled={signingOut}
                                        aria-busy={signingOut}
                                        className="nav-pill danger"
                                        style={{ width: '100%', justifyContent: 'flex-start', opacity: signingOut ? 0.6 : 1, cursor: signingOut ? 'wait' : 'pointer' }}
                                    >
                                        {signingOut ? 'Signing out…' : 'Sign out'}
                                    </button>
                                </>
                            ) : (
                                <Link
                                    to="/auth"
                                    onClick={() => setMenuOpen(false)}
                                    className="nav-pill"
                                    style={{ width: '100%', justifyContent: 'flex-start' }}
                                >
                                    Sign in
                                </Link>
                            )}
                        </div>
                    )}
                </>
            ) : (
                <div className="nav-actions">
                    <PrepMenu isActive={isActive} pathname={location.pathname} />

                    <ThemeToggle />

                    {user ? (
                        <Link to="/profile" data-tour="profile" className={`nav-pill${isActive('/profile') ? ' active' : ''}`}>
                            {avatar}
                            {profileLabel}
                        </Link>
                    ) : (
                        <Link to="/auth" className="nav-pill">Sign in</Link>
                    )}
                </div>
            )}
        </nav>
        {!compact && <NavTabs isActive={isActive} />}
      </>
    )
}

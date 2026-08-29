import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useMediaQuery } from '../lib/useMediaQuery'

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

const NAV_LINKS = [
    { to: '/', label: 'Optimizer' },
    { to: '/dsa', label: 'DSA' },
    { to: '/lld', label: 'LLD' },
    { to: '/hld', label: 'HLD' },
    { to: '/interview', label: 'Interview' },
]

export default function Navbar() {
    const { user, logout } = useAuth()
    const navigate = useNavigate()
    const location = useLocation()
    const isMobile = useMediaQuery('(max-width: 767px)')
    const [menuOpen, setMenuOpen] = useState(false)
    const navRef = useRef(null)

    const handleLogout = async () => {
        setMenuOpen(false)
        await logout()
        navigate('/auth')
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
    const avatar = (
        <span
            className="nav-avatar"
            style={{ background: stringToColor(user?.email), width: 18, height: 18, fontSize: '0.55rem', borderRadius: 3 }}
        >
            {getInitials(user)}
        </span>
    )

    return (
        <nav className="top-nav" ref={navRef}>
            <Link to="/" className="nav-brand">
                <span className="nav-pulse" />
                RESUMEOPT
            </Link>

            {isMobile ? (
                <>
                    <button
                        type="button"
                        className="nav-pill"
                        aria-label="Menu"
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
                            {NAV_LINKS.map(link => (
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

                            <Link
                                to="/profile"
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
                                className="nav-pill danger"
                                style={{ width: '100%', justifyContent: 'flex-start' }}
                            >
                                Sign out
                            </button>
                        </div>
                    )}
                </>
            ) : (
                <div className="nav-actions">
                    {NAV_LINKS.map(link => (
                        <Link key={link.to} to={link.to} className={`nav-pill${isActive(link.to) ? ' active' : ''}`}>
                            {link.label}
                        </Link>
                    ))}

                    <Link to="/profile" className={`nav-pill${isActive('/profile') ? ' active' : ''}`}>
                        {avatar}
                        {profileLabel}
                    </Link>
                </div>
            )}
        </nav>
    )
}

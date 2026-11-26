import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Moon, Sun } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../contexts/ThemeContext'
import { useAvatarUrl } from '../lib/useAvatar'
import { useMediaQuery } from '../lib/useMediaQuery'
import { getInitials, stringToColor } from '../lib/avatar'
import { NAV_SECTIONS, isWorkspacePath, meTarget, sectionFor } from '../lib/sections'
import { track, TRACK } from '../lib/track'
import { sectionIcon } from './ui/sectionIcons'

// WS-M0 top bar.
//   >= 768px: logo · the 5 sections (Jobs, Prepare, Auto Apply, Referrals, Me / Sign in) · theme toggle
//   <  768px: slim bar (logo + theme toggle); sections live in the bottom tab bar (components/ui/BottomNav,
//             mounted once in App.jsx).
// Sections, order, tones and the VITE_AUTOAPPLY flag come from lib/sections.js.

function ThemeToggle() {
    const { theme, toggleTheme } = useTheme()
    const isDark = theme === 'dark'
    return (
        <button
            type="button"
            className="nav-icon-btn"
            data-tour="theme"
            onClick={toggleTheme}
            aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
            title={isDark ? 'Light theme' : 'Dark theme'}
        >
            {isDark ? <Sun size={20} aria-hidden="true" /> : <Moon size={20} aria-hidden="true" />}
        </button>
    )
}

function Avatar({ user }) {
    const avatarUrl = useAvatarUrl()
    if (avatarUrl) {
        return <img className="nav-avatar" src={avatarUrl} alt="" referrerPolicy="no-referrer" />
    }
    return (
        // stringToColor() is the per-user avatar colour (existing, data-derived), not a theme colour
        <span className="nav-avatar" style={{ background: stringToColor(user?.email) }}>{getInitials(user)}</span>
    )
}

function SectionLinks({ user, active }) {
    const profileLabel = user?.user_metadata?.full_name?.split(' ')[0] || user?.email?.split('@')[0] || 'Me'
    return (
        <div className="nav-sections" role="navigation" aria-label="Sections">
            {NAV_SECTIONS.map((s) => {
                const on = s.id === active
                const isMe = s.id === 'me'
                const Icon = sectionIcon(s)
                return (
                    <Link
                        key={s.id}
                        to={isMe ? meTarget(!!user) : s.to}
                        data-tour={isMe ? 'profile' : s.id}
                        aria-current={on ? 'page' : undefined}
                        className={'nav-sec' + (on ? ' is-on' : '')}
                        style={{ '--tone': s.tone }}
                        onClick={() => track(TRACK.TAB_VIEW, { tab: s.id, from: 'top_nav' })}
                    >
                        {isMe && user ? <Avatar user={user} /> : <Icon size={17} aria-hidden="true" />}
                        <span>{isMe ? (user ? profileLabel : 'Sign in') : s.tab}</span>
                    </Link>
                )
            })}
        </div>
    )
}

export default function Navbar() {
    const { user } = useAuth() || {}
    const location = useLocation()
    const isMobile = useMediaQuery('(max-width: 767px)')
    // Full-height workspace screens on phones also drop the bottom tab bar (more room for the editor).
    const compact = isMobile && isWorkspacePath(location.pathname)
    useEffect(() => {
        const el = document.documentElement
        if (compact) el.setAttribute('data-nav-compact', '')
        else el.removeAttribute('data-nav-compact')
        return () => el.removeAttribute('data-nav-compact')
    }, [compact])

    const active = sectionFor(location.pathname).id

    return (
        <nav className="top-nav" aria-label="Top">
            <Link to="/" className="nav-brand" aria-label="Vloombox home">
                <img src="/vloombox-logo.svg" alt="" width="42" height="42" style={{ display: 'block' }} />
                <span>VLOOMBOX</span>
            </Link>

            {isMobile ? (
                <ThemeToggle />
            ) : (
                <div className="nav-actions">
                    <SectionLinks user={user} active={active} />
                    <ThemeToggle />
                </div>
            )}
        </nav>
    )
}

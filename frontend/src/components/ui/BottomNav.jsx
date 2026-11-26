import { Link, useLocation } from 'react-router-dom'
import { skipToken, useQuery } from '@tanstack/react-query'
import { useAuth } from '../../contexts/AuthContext'
import { NAV_SECTIONS, isWorkspacePath, meTarget, sectionFor } from '../../lib/sections'
import { track, TRACK } from '../../lib/track'
import { sectionIcon } from './sectionIcons'

// Answers-needed count, read from the react-query cache ONLY (no request of its
// own): the Auto Apply pages already fetch ['aa','needs-you',uid] (lib/useAutoApply.js
// useNeedsYou). The badge appears once any Auto Apply page has loaded it this session.
// TODO(WS-M0): a cheap count endpoint would let the badge show before the first visit.
function useCachedNeedsCount(uid) {
    const { data } = useQuery({ queryKey: ['aa', 'needs-you', uid], queryFn: skipToken, enabled: false })
    const n = Array.isArray(data?.items) ? data.items.length : 0
    return uid ? n : 0
}

/**
 * Fixed bottom tab bar for phones (< 768px; hidden by CSS on wider screens).
 * Mounted once in App.jsx. Tabs come from lib/sections.js (4 tabs when
 * VITE_AUTOAPPLY is off). Hidden on the full-height LLD / HLD workspaces.
 *
 *   <BottomNav />                         // badge from the cached needs-you list
 *   <BottomNav badges={{ autoapply: 3 }} /> // explicit badge counts per section id
 */
export default function BottomNav({ badges }) {
    const { user } = useAuth() || {}
    const { pathname } = useLocation()
    const needs = useCachedNeedsCount(user?.id)
    if (isWorkspacePath(pathname)) return null
    const active = sectionFor(pathname).id
    const counts = { autoapply: needs, ...(badges || {}) }

    return (
        <nav className="sys-bnav" aria-label="Main">
            {NAV_SECTIONS.map((s) => {
                const Icon = sectionIcon(s)
                const on = s.id === active
                const to = s.id === 'me' ? meTarget(!!user) : s.to
                const label = s.id === 'me' && !user ? 'Sign in' : s.tab
                const n = Number(counts[s.id]) || 0
                return (
                    <Link
                        key={s.id}
                        to={to}
                        className={'sys-bnav-tab' + (on ? ' is-on' : '')}
                        style={{ '--tone': s.tone }}
                        aria-current={on ? 'page' : undefined}
                        data-tour={s.id}
                        onClick={() => track(TRACK.TAB_VIEW, { tab: s.id, from: 'bottom_nav' })}
                    >
                        <span className="sys-bnav-icon" aria-hidden="true">
                            <Icon size={22} strokeWidth={on ? 2.4 : 2} />
                            {n > 0 && <span className="sys-bnav-badge">{n > 99 ? '99+' : n}</span>}
                        </span>
                        <span className="sys-bnav-label">{label}</span>
                        {n > 0 && <span className="sys-sr">, {n} {s.id === 'autoapply' ? 'answers needed' : 'new'}</span>}
                    </Link>
                )
            })}
        </nav>
    )
}

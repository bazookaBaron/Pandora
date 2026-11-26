import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { AUTOAPPLY_ENABLED, getSection } from '../../lib/sections'
import { isBot, track, TRACK } from '../../lib/track'
import { readFlag, writeFlag } from './storage'
import Sheet from '../ui/Sheet'
import { sectionIcon } from '../ui/sectionIcons'

// localStorage / sessionStorage keys (all access is try/catch-wrapped via storage.js / below)
export const LANDING_KEY = 'vb_landing_v1'  // chosen section id -> landing tab on later visits
const VISITED_KEY = 'vb_visited_v1'          // set on the first visit, whatever the landing page
const LANDED_SESSION_KEY = 'vb_landed_v1'    // sessionStorage: landing redirect already decided this session

const CHOICES = [
    { id: 'jobs', title: 'Find jobs', sub: 'Fresh jobs, updated daily' },
    ...(AUTOAPPLY_ENABLED ? [{ id: 'autoapply', title: 'Apply for me', sub: 'We apply to 50 jobs for you' }] : []),
    { id: 'prepare', title: 'Prepare', sub: 'DSA, design, interview questions' },
    { id: 'referrals', title: 'Get a referral', sub: 'Ask employees directly' },
]

function sessionGet(key) { try { return window.sessionStorage.getItem(key) } catch { return null } }
function sessionSet(key) { try { window.sessionStorage.setItem(key, '1') } catch { /* blocked */ } }

/** Stored landing section id, or null. */
export function readLanding() {
    const v = readFlag(LANDING_KEY)
    return v && CHOICES.some((c) => c.id === v) ? v : null
}

/**
 * First-visit "What do you want to do?" picker + landing tab (plan §4.1).
 * Mounted once in App.jsx. Client-only and conservative, so SEO / SSR output of
 * "/" never changes:
 *  • never for bots / automation (lib/track isBot) and never server-side;
 *  • only when the visit STARTS on "/" (no query / hash): a deep link skips it;
 *  • only on a real first visit (no vb_visited_v1 flag) and only signed out;
 *  • on later visits that start on "/", the stored choice becomes the landing tab
 *    (client-side replace navigation, once per browser session; Auto Apply only
 *    when signed in).
 */
export default function FirstVisitPicker() {
    const { user, loading } = useAuth() || {}
    const location = useLocation()
    const navigate = useNavigate()
    const entry = useRef(null)
    if (entry.current === null) entry.current = { path: location.pathname, plain: !location.search && !location.hash }
    const decided = useRef(false)
    const [open, setOpen] = useState(false)

    useEffect(() => {
        if (decided.current || loading) return
        decided.current = true
        if (isBot()) return
        const firstVisit = !readFlag(VISITED_KEY)
        writeFlag(VISITED_KEY, '1')
        const atHome = entry.current.path === '/' && entry.current.plain
        // the user already moved on before auth resolved: leave them where they are
        if (!atHome || location.pathname !== '/') return

        const landing = readLanding()
        if (landing) {
            if (sessionGet(LANDED_SESSION_KEY)) return
            sessionSet(LANDED_SESSION_KEY)
            if (landing === 'jobs') return
            if (landing === 'autoapply' && !user) return
            navigate(getSection(landing).to, { replace: true })
            return
        }
        sessionSet(LANDED_SESSION_KEY)
        if (firstVisit && !user) setOpen(true)
    }, [loading]) // eslint-disable-line react-hooks/exhaustive-deps

    // close if the user navigates away some other way (e.g. browser back)
    useEffect(() => { if (open && location.pathname !== '/') setOpen(false) }, [location.pathname]) // eslint-disable-line react-hooks/exhaustive-deps

    if (!open) return null

    const pick = (id) => {
        writeFlag(LANDING_KEY, id)
        track(TRACK.FIRST_VISIT_PICK, { choice: id })
        setOpen(false)
        const to = getSection(id).to
        if (to !== '/') navigate(to)
    }
    const skip = () => {
        track(TRACK.FIRST_VISIT_PICK, { choice: 'skip' })
        setOpen(false)
    }

    return (
        <Sheet open={open} onClose={skip} title="What do you want to do?" description="Pick one. You can switch any time from the tabs.">
            <ul className="sys-tiles-sec" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
                {CHOICES.map((c) => {
                    const s = getSection(c.id)
                    const Icon = sectionIcon(s)
                    return (
                        <li key={c.id}>
                            <button type="button" className="sys-sectile" style={{ '--tone': s.tone }} onClick={() => pick(c.id)}>
                                <span className="sys-sectile-icon" aria-hidden="true"><Icon size={22} /></span>
                                <span className="sys-sectile-text">
                                    <span className="sys-sectile-title">{c.title}</span>
                                    <span className="sys-sectile-sub">{c.sub}</span>
                                </span>
                                <ChevronRight className="sys-sectile-chev" size={18} aria-hidden="true" />
                            </button>
                        </li>
                    )
                })}
            </ul>
            <button type="button" className="sys-fvp-skip" onClick={skip}>Just look around</button>
        </Sheet>
    )
}

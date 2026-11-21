import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { readFlag, readGoals, tourProgressKeyFor, writeFlag } from './storage'
import './firstrun.css'

const AUTOAPPLY_ON = import.meta.env.VITE_AUTOAPPLY === '1'

// Each step navigates to `route`, waits for `anchor` (a data-tour value on that page's main
// control) and highlights it, also ringing the nav item `nav`. Missing anchor -> falls back to the
// nav item, then to a centered tooltip. `route: null` stays on the current page.
const BASE_STEPS = [
    { id: 'jobs', goal: 'jobs', route: '/', nav: 'jobs', anchor: 'jobs-filters', title: 'Jobs board', text: 'Search and filter fresh openings by role, city, company and level.' },
    ...(AUTOAPPLY_ON ? [{ id: 'autoapply', goal: 'autoapply', route: '/autoapply', nav: 'autoapply', anchor: 'autoapply-pipeline', title: 'Auto Apply', text: 'Pick a pipeline once and we apply to matching jobs for you.' }] : []),
    { id: 'referrals', goal: 'referrals', route: '/referrals', nav: 'referrals', anchor: 'referrals-tabs', title: 'Referrals', text: 'Request a referral, browse open requests, or track your own.' },
    { id: 'prep', goal: 'practice', route: '/dsa', nav: 'prep', anchor: 'dsa-list', title: 'Prep', text: 'DSA, HLD, LLD and Interview Questions live under Prep; start with company-wise DSA problems.' },
    { id: 'profile', goal: null, route: '/profile', nav: 'profile', anchor: 'profile-hero', title: 'Profile', text: 'Your details, plan and referral preferences live here.' },
    { id: 'theme', goal: null, route: null, nav: 'theme', anchor: 'theme', title: 'Theme', text: 'Switch between light and dark any time.' },
]

const WAIT_MS = 3000

const PAD = 6
const FOCUSABLE = 'button:not([disabled])'

function findTarget(id) {
    const els = document.querySelectorAll(`[data-tour="${id}"]`)
    for (const el of els) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) return el
    }
    return null
}

function measure(id) {
    const el = findTarget(id)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: r.top, left: r.left, width: r.width, height: r.height }
}

function readProgress(uid) {
    try {
        const v = JSON.parse(readFlag(tourProgressKeyFor(uid)) || 'null')
        return v && typeof v === 'object' ? v : null
    } catch { return null }
}

/** Resolves with the visible [data-tour=id] element, or null after `timeout` ms (or when cancelled). */
function waitForSelector(id, isCancelled, timeout = WAIT_MS) {
    return new Promise((resolve) => {
        const t0 = Date.now()
        const tick = () => {
            if (isCancelled()) return resolve(null)
            let el = null
            try { el = findTarget(id) } catch { el = null }
            if (el) return resolve(el)
            if (Date.now() - t0 >= timeout) return resolve(null)
            requestAnimationFrame(tick)
        }
        tick()
    })
}

/** Spotlight tour: blurred+dimmed page with one highlighted element and a tooltip. */
export default function GuidedTour({ uid, onClose }) {
    const navigate = useNavigate()
    const location = useLocation()
    const pathRef = useRef(location.pathname)
    pathRef.current = location.pathname

    const steps = useMemo(() => {
        const goals = readGoals(uid)
        // steps matching a chosen goal go first (stable otherwise)
        return BASE_STEPS
            .map((s, i) => ({ s, i, rank: s.goal && goals.includes(s.goal) ? 0 : 1 }))
            .sort((a, b) => a.rank - b.rank || a.i - b.i)
            .map((x) => x.s)
    }, [uid])

    // where the user started (restored after a reload) so closing the tour returns them there
    const originRef = useRef(null)
    const [idx, setIdx] = useState(() => {
        const p = readProgress(uid)
        const i = p ? steps.findIndex((s) => s.id === p.id) : -1
        const start = location.pathname + location.search
        originRef.current = p && typeof p.from === 'string' ? p.from : (/^\/(auth|profile)/.test(start) ? '/' : start)
        return i >= 0 ? i : 0
    })
    const dirRef = useRef(1)
    const [target, setTarget] = useState({ anchor: null, nav: null })
    const [rect, setRect] = useState(null)
    const [navRect, setNavRect] = useState(null)
    const [pos, setPos] = useState(null)
    const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight })
    const tipRef = useRef(null)
    const step = steps[idx]
    const last = idx === steps.length - 1

    // persist progress so a reload resumes mid-tour
    useEffect(() => {
        writeFlag(tourProgressKeyFor(uid), JSON.stringify({ id: step.id, from: originRef.current }))
    }, [uid, step.id])

    // close = end the tour and put the user back where they started
    const finish = useCallback(() => {
        writeFlag(tourProgressKeyFor(uid), null)
        const from = originRef.current || '/'
        if (pathRef.current + window.location.search !== from) { try { navigate(from) } catch { /* ignore */ } }
        onClose()
    }, [uid, navigate, onClose])

    // navigate -> wait for the page anchor -> highlight (skip the step if the route redirected away)
    useEffect(() => {
        let cancelled = false
        const isCancelled = () => cancelled
        setTarget({ anchor: null, nav: null })
        const run = async () => {
            try {
                if (step.route && pathRef.current !== step.route) navigate(step.route)
                const anchorEl = await waitForSelector(step.anchor, isCancelled)
                if (cancelled) return
                const navEl = step.nav && step.nav !== step.anchor ? findTarget(step.nav) : null
                const arrived = !step.route || pathRef.current === step.route
                if (!arrived && !anchorEl) {
                    // redirected (e.g. gated page): skip this step in the direction of travel
                    const n = idx + dirRef.current
                    if (n >= steps.length) { finish(); return }
                    if (n >= 0) { setIdx(n); return }
                }
                if (anchorEl) { try { anchorEl.scrollIntoView({ block: 'center', inline: 'nearest' }) } catch { /* old browser */ } }
                setTarget({ anchor: anchorEl, nav: navEl })
            } catch {
                if (!cancelled) setTarget({ anchor: null, nav: null })
            }
        }
        run()
        return () => { cancelled = true }
    }, [idx]) // eslint-disable-line react-hooks/exhaustive-deps

    const measureAll = useCallback(() => {
        setVp((v) => (v.w === window.innerWidth && v.h === window.innerHeight ? v : { w: window.innerWidth, h: window.innerHeight }))
        const grab = (el) => {
            if (!el || !el.isConnected) return null
            const r = el.getBoundingClientRect()
            return r.width > 0 && r.height > 0 ? { top: r.top, left: r.left, width: r.width, height: r.height } : null
        }
        const same = (a, b) => a === b || (a && b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height)
        const a = grab(target.anchor)
        const n = grab(target.nav)
        setRect((p) => (same(p, a) ? p : a))
        setNavRect((p) => (same(p, n) ? p : n))
    }, [target])

    useLayoutEffect(() => {
        measureAll()
        window.addEventListener('resize', measureAll)
        window.addEventListener('scroll', measureAll, true)
        const t = setInterval(measureAll, 400) // late layout shifts as the page data loads
        return () => {
            window.removeEventListener('resize', measureAll)
            window.removeEventListener('scroll', measureAll, true)
            clearInterval(t)
        }
    }, [measureAll])

    // Spotlight: the page anchor, else the nav item, else a centered tooltip.
    const spot = rect || navRect

    // place the tooltip below the target (above if no room), clamped to the viewport
    useLayoutEffect(() => {
        const tip = tipRef.current
        if (!tip) return
        const tw = tip.offsetWidth
        const th = tip.offsetHeight
        if (!spot) { setPos(null); return }
        const m = 12
        let top = spot.top + spot.height + PAD + 10
        if (top + th > vp.h - m) top = spot.top - PAD - 10 - th
        if (top < m) top = Math.max(m, vp.h - th - m)
        const left = Math.min(Math.max(m, spot.left + spot.width / 2 - tw / 2), Math.max(m, vp.w - tw - m))
        setPos({ top, left })
    }, [spot, vp, idx])

    useEffect(() => {
        const opener = document.activeElement
        return () => { try { opener?.focus?.() } catch { /* gone */ } }
    }, [])
    useEffect(() => { tipRef.current?.focus() }, [idx])

    const next = () => { if (last) finish(); else { dirRef.current = 1; setIdx(idx + 1) } }
    const back = () => { if (idx > 0) { dirRef.current = -1; setIdx(idx - 1) } }

    function onKeyDown(e) {
        if (e.key === 'Escape') { e.stopPropagation(); finish(); return }
        if (e.key === 'ArrowRight') { e.preventDefault(); next(); return }
        if (e.key === 'ArrowLeft') { e.preventDefault(); back(); return }
        if (e.key === 'Tab' && tipRef.current) {
            const items = [...tipRef.current.querySelectorAll(FOCUSABLE)]
            if (!items.length) return
            const first = items[0]
            const lastEl = items[items.length - 1]
            const a = document.activeElement
            if (e.shiftKey && (a === first || a === tipRef.current)) { e.preventDefault(); lastEl.focus() }
            else if (!e.shiftKey && a === lastEl) { e.preventDefault(); first.focus() }
        }
    }

    // four panes around the target so the target itself stays sharp
    let panes
    let ring = null
    if (spot) {
        const t = Math.max(0, spot.top - PAD)
        const l = Math.max(0, spot.left - PAD)
        const r = Math.min(vp.w, spot.left + spot.width + PAD)
        const b = Math.min(vp.h, spot.top + spot.height + PAD)
        panes = [
            { top: 0, left: 0, width: vp.w, height: t },
            { top: b, left: 0, width: vp.w, height: Math.max(0, vp.h - b) },
            { top: t, left: 0, width: l, height: Math.max(0, b - t) },
            { top: t, left: r, width: Math.max(0, vp.w - r), height: Math.max(0, b - t) },
        ]
        ring = { top: t, left: l, width: r - l, height: b - t }
    } else {
        panes = [{ top: 0, left: 0, width: vp.w, height: vp.h }]
    }
    const navRing = rect && navRect
        ? { top: navRect.top - 4, left: navRect.left - 4, width: navRect.width + 8, height: navRect.height + 8 }
        : null

    return (
        <div className="fr-tour" onKeyDown={onKeyDown}>
            {panes.map((p, i) => <div key={i} className="fr-pane" style={p} onClick={(e) => e.stopPropagation()} />)}
            {ring && <div className="fr-ring" style={ring} aria-hidden="true" />}
            {navRing && <div key={step.id} className="fr-ring is-nav" style={navRing} aria-hidden="true" />}
            <div
                ref={tipRef}
                className={'fr-tip' + (spot && pos ? '' : ' is-center')}
                style={spot && pos ? { top: pos.top, left: pos.left } : undefined}
                role="dialog"
                aria-modal="true"
                aria-label={`Tour: ${step.title}`}
                tabIndex={-1}
            >
                <div className="fr-tip-head">
                    <strong>{step.title}</strong>
                    <button type="button" className="fr-skip" onClick={finish}>Skip</button>
                </div>
                <p className="fr-tip-text">{step.text}</p>
                <div className="fr-tip-foot">
                    <div className="fr-dots" aria-label={`Step ${idx + 1} of ${steps.length}`}>
                        {steps.map((s, i) => <span key={s.id} className={'fr-pip' + (i === idx ? ' is-on' : '')} />)}
                    </div>
                    <div className="fr-actions-r">
                        {idx > 0 && <button type="button" className="fr-btn" onClick={back}>Back</button>}
                        <button type="button" className="fr-btn is-primary" onClick={next}>{last ? 'Done' : 'Next'}</button>
                    </div>
                </div>
            </div>
        </div>
    )
}

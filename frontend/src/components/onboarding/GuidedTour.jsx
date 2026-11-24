import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { readFlag, tourProgressKeyFor, writeFlag } from './storage'
import './firstrun.css'

const AUTOAPPLY_ON = import.meta.env.VITE_AUTOAPPLY === '1'

// Each step navigates to `route`, waits for `anchor` (a CSS selector; the first visible match wins)
// and cuts it out of a plain dim overlay, also cutting out the navbar item `nav`. `openMenu` opens
// the Prep menu (desktop dropdown or mobile hamburger sheet) first and shows `note`.
// Missing anchor -> falls back to the nav item, then to a centered tooltip.
const STEPS = [
    {
        id: 'jobs', route: '/', nav: '[data-tour="jobs"]', anchor: '[data-tour="jobs-filters"]',
        title: 'Jobs', text: 'Browse fresh openings and filter them by role, city, company and level.',
    },
    {
        id: 'dsa', route: '/dsa', nav: '[data-tour="prep"]', anchor: '[data-tour="dsa-list"]',
        title: 'DSA practice', text: 'Work through company-wise DSA problems and track what you have solved.',
    },
    {
        id: 'design', route: '/dsa', openMenu: true, nav: '[data-tour="prep"]', anchor: '.prep-menu-list, .mobile-prep-group',
        title: 'HLD and LLD', text: 'System design practice for high-level and low-level design rounds lives in the Prep menu.',
        note: "We've opened the menu for you.",
    },
    ...(AUTOAPPLY_ON ? [{
        id: 'autoapply', route: '/autoapply', nav: '[data-tour="autoapply"]', anchor: '[data-tour="autoapply-pipeline"]',
        title: 'Auto Apply', text: 'Choose a pipeline once and we apply to matching jobs on your behalf.',
    }] : []),
]

const WAIT_MS = 3000
const PAD = 6
const FOCUSABLE = 'button:not([disabled])'
const MENU_BTN = '[data-tour="prep"]'

function findTarget(sel) {
    if (!sel) return null
    let els
    try { els = document.querySelectorAll(sel) } catch { return null }
    for (const el of els) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) return el
    }
    return null
}

/** Opens/closes the Prep menu (desktop dropdown or mobile sheet) by toggling its own button. */
function setMenuOpen(open) {
    const btn = findTarget(MENU_BTN)
    if (!btn) return
    const isOpen = btn.getAttribute('aria-expanded') === 'true'
    if (isOpen !== open) { try { btn.click() } catch { /* ignore */ } }
}

function readProgress(uid) {
    try {
        const v = JSON.parse(readFlag(tourProgressKeyFor(uid)) || 'null')
        return v && typeof v === 'object' ? v : null
    } catch { return null }
}

/** Resolves with the first visible match of `sel`, or null after `timeout` ms (or when cancelled). */
function waitForSelector(sel, isCancelled, timeout = WAIT_MS) {
    return new Promise((resolve) => {
        const t0 = Date.now()
        const tick = () => {
            if (isCancelled()) return resolve(null)
            const el = findTarget(sel)
            if (el) return resolve(el)
            if (Date.now() - t0 >= timeout) return resolve(null)
            requestAnimationFrame(tick)
        }
        tick()
    })
}

const grab = (el) => {
    if (!el || !el.isConnected) return null
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 ? { top: r.top, left: r.left, width: r.width, height: r.height } : null
}
const same = (a, b) => a === b || (a && b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height)
const padRect = (r, p, vp) => {
    const top = Math.max(0, Math.round(r.top - p))
    const left = Math.max(0, Math.round(r.left - p))
    const bottom = Math.min(vp.h, Math.round(r.top + r.height + p))
    const right = Math.min(vp.w, Math.round(r.left + r.width + p))
    return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/**
 * Spotlight tour: a plain semi-transparent overlay (no blur) with the target and its navbar item
 * cut out so they stay crisp, plus a tooltip card. Clicks outside the card are swallowed.
 */
export default function GuidedTour({ uid, onClose }) {
    const navigate = useNavigate()
    const location = useLocation()
    const pathRef = useRef(location.pathname)
    pathRef.current = location.pathname
    const maskId = 'fr-mask-' + useId().replace(/[^a-zA-Z0-9_-]/g, '')
    const steps = STEPS

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

    // never leave the menu open behind us
    useEffect(() => () => setMenuOpen(false), [])

    // close = end the tour and put the user back where they started
    const finish = useCallback(() => {
        writeFlag(tourProgressKeyFor(uid), null)
        setMenuOpen(false)
        const from = originRef.current || '/'
        if (pathRef.current + window.location.search !== from) { try { navigate(from) } catch { /* ignore */ } }
        onClose()
    }, [uid, navigate, onClose])

    // navigate -> (open menu) -> wait for the anchor -> highlight (skip the step if the route redirected away)
    useEffect(() => {
        let cancelled = false
        const isCancelled = () => cancelled
        setTarget({ anchor: null, nav: null })
        if (!step.openMenu) setMenuOpen(false)
        const run = async () => {
            try {
                if (step.route && pathRef.current !== step.route) navigate(step.route)
                if (step.openMenu) {
                    // the menus close on route change, so open only once the route has settled
                    const t0 = Date.now()
                    while (!cancelled && step.route && pathRef.current !== step.route && Date.now() - t0 < WAIT_MS) {
                        await new Promise((r) => setTimeout(r, 50))
                    }
                    await waitForSelector(MENU_BTN, isCancelled)
                    await new Promise((r) => setTimeout(r, 60))
                    if (cancelled) return
                    setMenuOpen(true)
                }
                const anchorEl = await waitForSelector(step.anchor, isCancelled)
                if (cancelled) return
                const navEl = findTarget(step.nav)
                const arrived = !step.route || pathRef.current === step.route
                if (!arrived && !anchorEl) {
                    // redirected (e.g. gated page): skip this step in the direction of travel
                    const n = idx + dirRef.current
                    if (n >= steps.length) { finish(); return }
                    if (n >= 0) { setIdx(n); return }
                }
                if (anchorEl && !step.openMenu) {
                    try { anchorEl.scrollIntoView({ block: 'center', inline: 'nearest' }) } catch { /* old browser */ }
                }
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

    // place the tooltip below the target (above if no room), clamped to the viewport, on whole pixels
    useLayoutEffect(() => {
        const tip = tipRef.current
        if (!tip) return
        if (!spot) { setPos(null); return }
        const tw = tip.offsetWidth
        const th = tip.offsetHeight
        const m = 12
        let top = spot.top + spot.height + PAD + 10
        if (top + th > vp.h - m) top = spot.top - PAD - 10 - th
        if (top < m) top = Math.max(m, vp.h - th - m)
        const left = Math.min(Math.max(m, spot.left + spot.width / 2 - tw / 2), Math.max(m, vp.w - tw - m))
        setPos({ top: Math.round(top), left: Math.round(left) })
    }, [spot, vp, idx])

    useEffect(() => {
        const opener = document.activeElement
        return () => { try { opener?.focus?.() } catch { /* gone */ } }
    }, [])
    useEffect(() => { tipRef.current?.focus({ preventScroll: true }) }, [idx])

    const next = () => { if (last) finish(); else { dirRef.current = 1; setIdx(idx + 1) } }
    const back = () => { if (idx > 0) { dirRef.current = -1; setIdx(idx - 1) } }

    function onKeyDown(e) {
        // keep the navbar's own Escape/outside handlers from fighting the tour
        e.stopPropagation()
        if (e.key === 'Escape') { finish(); return }
        if (e.key === 'ArrowRight') { e.preventDefault(); next(); return }
        if (e.key === 'ArrowLeft') { e.preventDefault(); back(); return }
        if (e.key === 'Tab' && tipRef.current) {
            const items = [...tipRef.current.querySelectorAll(FOCUSABLE)]
            if (!items.length) { e.preventDefault(); return }
            const first = items[0]
            const lastEl = items[items.length - 1]
            const a = document.activeElement
            if (e.shiftKey && (a === first || a === tipRef.current)) { e.preventDefault(); lastEl.focus() }
            else if (!e.shiftKey && a === lastEl) { e.preventDefault(); first.focus() }
            else if (!tipRef.current.contains(a)) { e.preventDefault(); first.focus() }
        }
    }

    // Swallow pointer events so the page (and the open Prep menu's outside-click handler) never sees them.
    const swallow = (e) => { e.stopPropagation(); if (e.type !== 'mousedown' && e.type !== 'touchstart') e.preventDefault() }

    const holes = []
    if (step.openMenu && rect && navRect) {
        // the menu button and its open list read as one highlighted block
        const top = Math.min(rect.top, navRect.top)
        const left = Math.min(rect.left, navRect.left)
        const bottom = Math.max(rect.top + rect.height, navRect.top + navRect.height)
        const right = Math.max(rect.left + rect.width, navRect.left + navRect.width)
        holes.push(padRect({ top, left, width: right - left, height: bottom - top }, PAD, vp))
    } else {
        if (rect) holes.push(padRect(rect, PAD, vp))
        if (navRect) holes.push(padRect(navRect, 4, vp))
    }

    return (
        <div className="fr-tour" onKeyDown={onKeyDown}>
            <div
                className="fr-shield"
                aria-hidden="true"
                onMouseDown={swallow}
                onTouchStart={swallow}
                onClick={swallow}
            />
            <svg className="fr-dim" width={vp.w} height={vp.h} aria-hidden="true" focusable="false">
                <defs>
                    <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={vp.w} height={vp.h}>
                        <rect x="0" y="0" width={vp.w} height={vp.h} fill="white" />
                        {holes.map((h, i) => <rect key={i} x={h.left} y={h.top} width={h.width} height={h.height} rx="8" fill="black" />)}
                    </mask>
                </defs>
                <rect className="fr-dim-fill" x="0" y="0" width={vp.w} height={vp.h} mask={`url(#${maskId})`} />
            </svg>
            {holes.map((h, i) => (
                <div key={step.id + i} className={'fr-ring' + (i === 1 ? ' is-nav' : '')} style={h} aria-hidden="true" />
            ))}
            <p className="fr-live" aria-live="polite" aria-atomic="true">
                {`Step ${idx + 1} of ${steps.length}: ${step.title}. ${step.note ? step.note + ' ' : ''}${step.text}`}
            </p>
            <div
                ref={tipRef}
                className={'fr-tip' + (spot && pos ? '' : ' is-center')}
                style={spot && pos ? { top: pos.top, left: pos.left } : undefined}
                role="dialog"
                aria-modal="true"
                aria-labelledby={maskId + '-t'}
                aria-describedby={maskId + '-d'}
                tabIndex={-1}
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
            >
                <div className="fr-tip-head">
                    <span className="fr-tip-count">{idx + 1} / {steps.length}</span>
                    <button type="button" className="fr-skip" onClick={finish}>Skip</button>
                </div>
                <strong className="fr-tip-title" id={maskId + '-t'}>{step.title}</strong>
                {step.note && <p className="fr-tip-note">{step.note}</p>}
                <p className="fr-tip-text" id={maskId + '-d'}>{step.text}</p>
                <div className="fr-tip-foot">
                    <div className="fr-dots" aria-hidden="true">
                        {steps.map((s, i) => <span key={s.id} className={'fr-pip' + (i === idx ? ' is-on' : '')} />)}
                    </div>
                    <div className="fr-actions-r">
                        {idx > 0 && <button type="button" className="fr-btn" onClick={back}>Back</button>}
                        <button type="button" className="fr-btn is-primary" onClick={next}>{last ? 'Got it' : 'Next'}</button>
                    </div>
                </div>
            </div>
        </div>
    )
}

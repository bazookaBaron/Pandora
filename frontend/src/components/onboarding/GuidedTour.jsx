import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { readGoals } from './storage'
import './firstrun.css'

const AUTOAPPLY_ON = import.meta.env.VITE_AUTOAPPLY === '1'

// target = value of the data-tour attribute on a Navbar element. If the target is
// missing/hidden (e.g. inside the closed mobile menu) the tooltip is centered.
const BASE_STEPS = [
    { id: 'jobs', goal: 'jobs', title: 'Jobs board', text: 'Fresh openings from company career sites. Filter by role, city and company.' },
    ...(AUTOAPPLY_ON ? [{ id: 'autoapply', goal: 'autoapply', title: 'Auto Apply', text: 'Set it up once and we apply to matching jobs for you.' }] : []),
    { id: 'referrals', goal: 'referrals', title: 'Referrals', text: 'Ask employees for a referral, or refer others at your company.' },
    { id: 'dsa', goal: 'practice', title: 'DSA', text: 'Company-wise coding problems, most-asked first.' },
    { id: 'lld', goal: 'practice', title: 'LLD', text: 'Low-level design: classes and patterns for interview rounds.' },
    { id: 'hld', goal: 'practice', title: 'HLD', text: 'High-level system design: architecture and scale walkthroughs.' },
    { id: 'profile', goal: null, title: 'Profile', text: 'Your details, plan and referral preferences live here.' },
    { id: 'theme', goal: null, title: 'Theme', text: 'Switch between light and dark any time.' },
]

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

/** Spotlight tour: blurred+dimmed page with one highlighted element and a tooltip. */
export default function GuidedTour({ uid, onClose }) {
    const steps = useMemo(() => {
        const goals = readGoals(uid)
        // steps matching a chosen goal go first (stable otherwise)
        return BASE_STEPS
            .map((s, i) => ({ s, i, rank: s.goal && goals.includes(s.goal) ? 0 : 1 }))
            .sort((a, b) => a.rank - b.rank || a.i - b.i)
            .map((x) => x.s)
    }, [uid])

    const [idx, setIdx] = useState(0)
    const [rect, setRect] = useState(null)
    const [pos, setPos] = useState(null)
    const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight })
    const tipRef = useRef(null)
    const step = steps[idx]
    const last = idx === steps.length - 1

    const update = useCallback(() => {
        setVp({ w: window.innerWidth, h: window.innerHeight })
        setRect(measure(step.id))
    }, [step.id])

    useLayoutEffect(() => {
        const el = findTarget(step.id)
        if (el) { try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } catch { /* old browser */ } }
        update()
        window.addEventListener('resize', update)
        window.addEventListener('scroll', update, true)
        return () => {
            window.removeEventListener('resize', update)
            window.removeEventListener('scroll', update, true)
        }
    }, [step.id, update])

    // place the tooltip below the target (above if no room), clamped to the viewport
    useLayoutEffect(() => {
        const tip = tipRef.current
        if (!tip) return
        const tw = tip.offsetWidth
        const th = tip.offsetHeight
        if (!rect) { setPos(null); return }
        const m = 12
        let top = rect.top + rect.height + PAD + 10
        if (top + th > vp.h - m) top = Math.max(m, rect.top - PAD - 10 - th)
        const left = Math.min(Math.max(m, rect.left + rect.width / 2 - tw / 2), Math.max(m, vp.w - tw - m))
        setPos({ top, left })
    }, [rect, vp, idx])

    useEffect(() => {
        const opener = document.activeElement
        return () => { try { opener?.focus?.() } catch { /* gone */ } }
    }, [])
    useEffect(() => { tipRef.current?.focus() }, [idx])

    const next = () => (last ? onClose() : setIdx((i) => i + 1))
    const back = () => setIdx((i) => Math.max(0, i - 1))

    function onKeyDown(e) {
        if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
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

    // four panes around the target so the target itself stays sharp and clickable-looking
    let panes
    let ring = null
    if (rect) {
        const t = Math.max(0, rect.top - PAD)
        const l = Math.max(0, rect.left - PAD)
        const r = Math.min(vp.w, rect.left + rect.width + PAD)
        const b = Math.min(vp.h, rect.top + rect.height + PAD)
        panes = [
            { top: 0, left: 0, width: vp.w, height: t },
            { top: b, left: 0, width: vp.w, height: Math.max(0, vp.h - b) },
            { top: t, left: 0, width: l, height: b - t },
            { top: t, left: r, width: Math.max(0, vp.w - r), height: b - t },
        ]
        ring = { top: t, left: l, width: r - l, height: b - t }
    } else {
        panes = [{ top: 0, left: 0, width: vp.w, height: vp.h }]
    }

    return (
        <div className="fr-tour" onKeyDown={onKeyDown}>
            {panes.map((p, i) => <div key={i} className="fr-pane" style={p} onClick={(e) => e.stopPropagation()} />)}
            {ring && <div className="fr-ring" style={ring} aria-hidden="true" />}
            <div
                ref={tipRef}
                className={'fr-tip' + (rect && pos ? '' : ' is-center')}
                style={rect && pos ? { top: pos.top, left: pos.left } : undefined}
                role="dialog"
                aria-modal="true"
                aria-label={`Tour: ${step.title}`}
                tabIndex={-1}
            >
                <div className="fr-tip-head">
                    <strong>{step.title}</strong>
                    <button type="button" className="fr-skip" onClick={onClose}>Skip</button>
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

import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import './welcome.css'

const AUTOAPPLY_ON = import.meta.env.VITE_AUTOAPPLY === '1'

const GOALS = [
    {
        id: 'dsa',
        title: 'Practice DSA',
        blurb: 'Company-wise problems, plus LLD and HLD.',
        next: 'Pick a company you are targeting and solve its most-asked problems first.',
        cta: { to: '/dsa', label: 'Start practising' },
    },
    {
        id: 'jobs',
        title: 'Find jobs',
        blurb: 'Fresh openings straight from company career sites.',
        next: 'Filter by role, city and company, then apply on the company site.',
        cta: { to: '/', label: 'Browse jobs' },
    },
    ...(AUTOAPPLY_ON ? [{
        id: 'autoapply',
        title: 'AutoApply',
        blurb: 'We apply to matching jobs for you (Pro or Max).',
        next: 'Set up once (resume, answers, preferences); the AutoApply page shows each next step.',
        cta: { to: '/autoapply', label: 'Set up AutoApply' },
    }] : []),
]

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * First-run welcome: 3 cards (what Vloombox does -> pick a goal -> one next action).
 * Modal dialog with a focus trap; Esc, Skip, the backdrop and the final action all close it,
 * and onClose marks it as seen. Lazy-loaded by WelcomeHost.
 */
export default function WelcomeModal({ onClose }) {
    const navigate = useNavigate()
    const [step, setStep] = useState(0)
    const [goal, setGoal] = useState(null)
    const dialogRef = useRef(null)
    const headingRef = useRef(null)
    const titleId = useId()
    const descId = useId()
    const total = 3
    const picked = GOALS.find((g) => g.id === goal) || null

    // focus management: remember the opener, focus the heading of each card, restore on close
    useEffect(() => {
        const opener = document.activeElement
        const prevOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
            document.body.style.overflow = prevOverflow
            if (opener && typeof opener.focus === 'function') {
                try { opener.focus() } catch { /* opener gone */ }
            }
        }
    }, [])
    useEffect(() => { headingRef.current?.focus() }, [step])

    function onKeyDown(e) {
        if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
            return
        }
        if (e.key !== 'Tab' || !dialogRef.current) return
        const items = [...dialogRef.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)
        if (!items.length) return
        const first = items[0]
        const last = items[items.length - 1]
        const active = document.activeElement
        if (e.shiftKey && (active === first || active === headingRef.current)) {
            e.preventDefault()
            last.focus()
        } else if (!e.shiftKey && active === last) {
            e.preventDefault()
            first.focus()
        }
    }

    function finish() {
        const to = picked?.cta.to
        onClose()
        if (to) navigate(to)
    }

    return (
        <div className="ob-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
            <div
                ref={dialogRef}
                className="ob-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={descId}
                onKeyDown={onKeyDown}
            >
                <div className="ob-dialog-top">
                    <span className="ob-progress" aria-label={`Step ${step + 1} of ${total}`}>
                        {Array.from({ length: total }, (_, i) => (
                            <span key={i} className={`ob-pip${i <= step ? ' is-on' : ''}`} aria-hidden />
                        ))}
                    </span>
                    <button type="button" className="ob-skip" onClick={onClose}>Skip</button>
                </div>

                {step === 0 && (
                    <>
                        <h2 id={titleId} ref={headingRef} tabIndex={-1} className="ob-dialog-title">Welcome to Vloombox</h2>
                        <p id={descId} className="ob-dialog-text">Everything for your next tech job, in one place.</p>
                        <ul className="ob-points">
                            <li><strong>Practice</strong> company-wise DSA, LLD and HLD.</li>
                            <li><strong>Find jobs</strong> posted in the last few days on company career sites.</li>
                            {AUTOAPPLY_ON && <li><strong>AutoApply</strong> lets us submit applications for you.</li>}
                        </ul>
                    </>
                )}

                {step === 1 && (
                    <>
                        <h2 id={titleId} ref={headingRef} tabIndex={-1} className="ob-dialog-title">What do you want to do first?</h2>
                        <p id={descId} className="ob-dialog-text">You can switch anytime from the top menu.</p>
                        <div className="ob-goals" role="radiogroup" aria-labelledby={titleId}>
                            {GOALS.map((g) => (
                                <label key={g.id} className={`ob-goal${goal === g.id ? ' is-on' : ''}`}>
                                    <input type="radio" name="ob-goal" value={g.id} checked={goal === g.id} onChange={() => setGoal(g.id)} />
                                    <span className="ob-goal-title">{g.title}</span>
                                    <span className="ob-goal-blurb">{g.blurb}</span>
                                </label>
                            ))}
                        </div>
                    </>
                )}

                {step === 2 && picked && (
                    <>
                        <h2 id={titleId} ref={headingRef} tabIndex={-1} className="ob-dialog-title">Your next step</h2>
                        <p id={descId} className="ob-dialog-text">{picked.next}</p>
                    </>
                )}

                <div className="ob-actions">
                    {step > 0 ? (
                        <button type="button" className="ob-btn" onClick={() => setStep((s) => s - 1)}>Back</button>
                    ) : <span />}
                    {step === 0 && <button type="button" className="ob-btn is-primary" onClick={() => setStep(1)}>Get started</button>}
                    {step === 1 && (
                        <button type="button" className="ob-btn is-primary" onClick={() => setStep(2)} disabled={!picked}>Next</button>
                    )}
                    {step === 2 && picked && (
                        <button type="button" className="ob-btn is-primary" onClick={finish}>{picked.cta.label}</button>
                    )}
                </div>
            </div>
        </div>
    )
}

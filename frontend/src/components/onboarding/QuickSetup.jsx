import { useEffect, useId, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { goalsKeyFor, writeFlag } from './storage'
import { ROLE_SUGGESTIONS } from '../../lib/roleSuggestions'
import './firstrun.css'

const AUTOAPPLY_ON = import.meta.env.VITE_AUTOAPPLY === '1'

const GOALS = [
    ...(AUTOAPPLY_ON ? [{ id: 'autoapply', label: 'Auto-apply to jobs' }] : []),
    { id: 'practice', label: 'Practice DSA / System design' },
    { id: 'referrals', label: 'Find referrals' },
    { id: 'jobs', label: 'Browse jobs' },
]

const STEPS = ['About you', 'What you want', 'Done']
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'

/**
 * Post-signup quick setup: 3 steps on one small centered card. Every step is
 * skippable. Profile fields go to `profiles` via upsert (allowed columns only);
 * goals stay in localStorage and only order the tour.
 * onFinish(withTour): called when done/skipped.
 */
export default function QuickSetup({ uid, onFinish }) {
    const [step, setStep] = useState(0)
    const [position, setPosition] = useState('')
    const [yoe, setYoe] = useState('')
    const [company, setCompany] = useState('')
    const [goals, setGoals] = useState([])
    const [saving, setSaving] = useState(false)
    const [saveErr, setSaveErr] = useState('')
    const cardRef = useRef(null)
    const headRef = useRef(null)
    const titleId = useId()
    const listId = useId()

    useEffect(() => {
        const opener = document.activeElement
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
            document.body.style.overflow = prev
            try { opener?.focus?.() } catch { /* gone */ }
        }
    }, [])
    useEffect(() => { headRef.current?.focus() }, [step])

    function onKeyDown(e) {
        if (e.key === 'Escape') { e.stopPropagation(); onFinish(true); return }
        if (e.key !== 'Tab' || !cardRef.current) return
        const items = [...cardRef.current.querySelectorAll(FOCUSABLE)]
        if (!items.length) return
        const first = items[0]
        const last = items[items.length - 1]
        const a = document.activeElement
        if (e.shiftKey && (a === first || a === headRef.current)) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus() }
    }

    async function saveProfile() {
        const pos = position.trim().slice(0, 120)
        const co = company.trim().slice(0, 120)
        const y = yoe === '' ? null : Math.max(0, Math.min(60, Math.round(Number(yoe))))
        if (!pos && !co && (y == null || !Number.isFinite(y))) return
        const row = { id: uid }
        if (pos) row.position = pos
        if (co) row.company = co
        if (y != null && Number.isFinite(y)) row.years_of_experience = y
        setSaving(true)
        setSaveErr('')
        try {
            const { error } = await supabase.from('profiles').upsert(row, { onConflict: 'id' })
            if (error) throw error
        } catch {
            setSaveErr('Could not save right now. You can add this later in Profile.')
        } finally {
            setSaving(false)
        }
    }

    async function next() {
        if (step === 0) await saveProfile() // never blocks: a failure only shows a hint
        if (step === 1) writeFlag(goalsKeyFor(uid), JSON.stringify(goals))
        setStep((s) => Math.min(2, s + 1))
    }

    const toggleGoal = (id) => setGoals((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]))

    return (
        <div className="fr-backdrop" onKeyDown={onKeyDown}>
            <div ref={cardRef} className="fr-card" role="dialog" aria-modal="true" aria-labelledby={titleId}>
                <ol className="fr-steps" aria-label="Setup progress">
                    {STEPS.map((s, i) => (
                        <li key={s} className={'fr-step' + (i < step ? ' is-done' : '') + (i === step ? ' is-now' : '')} aria-current={i === step ? 'step' : undefined}>
                            <span className="fr-dot">{i < step ? '✓' : i + 1}</span>
                            <span className="fr-step-label">{s}</span>
                        </li>
                    ))}
                </ol>

                {step === 0 && (
                    <div className="fr-body">
                        <h2 id={titleId} ref={headRef} tabIndex={-1} className="fr-title">Tell us a little about you</h2>
                        <p className="fr-sub">Helps with referrals and job matches. All optional.</p>
                        <label className="fr-field">
                            <span>Current role</span>
                            <input className="fr-input" list={listId} value={position} maxLength={120} placeholder="e.g. Business Analyst"
                                onChange={(e) => setPosition(e.target.value)} autoComplete="off" />
                            <datalist id={listId}>{ROLE_SUGGESTIONS.map((r) => <option key={r} value={r} />)}</datalist>
                        </label>
                        <div className="fr-row">
                            <label className="fr-field">
                                <span>Years of experience</span>
                                <input className="fr-input" type="number" inputMode="numeric" min="0" max="60" step="1" value={yoe}
                                    placeholder="0" onChange={(e) => setYoe(e.target.value)} />
                            </label>
                            <label className="fr-field">
                                <span>Company <em>(optional)</em></span>
                                <input className="fr-input" value={company} maxLength={120} placeholder="Where you work"
                                    onChange={(e) => setCompany(e.target.value)} autoComplete="organization" />
                            </label>
                        </div>
                        {saveErr && <p className="fr-err" role="status">{saveErr}</p>}
                    </div>
                )}

                {step === 1 && (
                    <div className="fr-body">
                        <h2 id={titleId} ref={headRef} tabIndex={-1} className="fr-title">What are you here for?</h2>
                        <p className="fr-sub">Pick any. Those come first in the tour.</p>
                        <div className="fr-chips" role="group" aria-label="Goals">
                            {GOALS.map((g) => (
                                <button key={g.id} type="button" className={'fr-chip' + (goals.includes(g.id) ? ' is-on' : '')}
                                    aria-pressed={goals.includes(g.id)} onClick={() => toggleGoal(g.id)}>{g.label}</button>
                            ))}
                        </div>
                    </div>
                )}

                {step === 2 && (
                    <div className="fr-body">
                        <h2 id={titleId} ref={headRef} tabIndex={-1} className="fr-title">You are all set</h2>
                        <p className="fr-sub">Want a 30-second look around? It points at each part of the navbar.</p>
                    </div>
                )}

                <div className="fr-actions">
                    {step < 2 ? (
                        <>
                            <button type="button" className="fr-skip" onClick={() => onFinish(true)}>Skip for now</button>
                            <div className="fr-actions-r">
                                {step > 0 && <button type="button" className="fr-btn" onClick={() => setStep(step - 1)}>Back</button>}
                                <button type="button" className="fr-btn is-primary" onClick={next} disabled={saving}>
                                    {saving ? 'Saving…' : 'Continue'}
                                </button>
                            </div>
                        </>
                    ) : (
                        <>
                            <button type="button" className="fr-skip" onClick={() => onFinish(false)}>Skip for now</button>
                            <button type="button" className="fr-btn is-primary" onClick={() => onFinish(true)}>Take the tour</button>
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}

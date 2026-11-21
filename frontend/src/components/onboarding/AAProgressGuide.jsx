import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { readFlag, writeFlag } from './storage'
import { useAAGuide } from './useAAGuide'
import './onboarding.css'

const COLLAPSE_KEY = 'vb_aa_guide_collapsed'

/**
 * Compact AutoApply progress stepper (horizontal; vertical on phones). Every state comes from
 * the server (see useAAGuide). Only the current step's sentence and one primary CTA are shown.
 * Renders nothing for ineligible users (the pages show the upgrade card) or before data loads.
 */
export default function AAProgressGuide({ style }) {
    const g = useAAGuide()
    const bodyId = useId()
    const [collapsed, setCollapsed] = useState(() => readFlag(COLLAPSE_KEY) === '1')

    if (!g.ready || !g.eligible) return null

    const toggle = () => {
        setCollapsed((c) => {
            writeFlag(COLLAPSE_KEY, c ? null : '1')
            return !c
        })
    }
    const cur = g.current

    return (
        <section className="ob-guide" aria-label="AutoApply progress" style={style}>
            <div className="ob-guide-head">
                <span className="ob-guide-title">
                    Your progress <span className="ob-guide-count">{g.doneCount} of {g.total}</span>
                </span>
                <button type="button" className="ob-link" onClick={toggle} aria-expanded={!collapsed} aria-controls={bodyId}>
                    {collapsed ? 'Show' : 'Hide'}
                </button>
            </div>
            {!collapsed && (
                <div id={bodyId}>
                    <ol className="ob-steps">
                        {g.steps.map((s, i) => (
                            <li key={s.id} className={`ob-step is-${s.state}`} aria-current={s.state === 'current' ? 'step' : undefined}>
                                <span className="ob-dot" aria-hidden>{s.state === 'done' ? '✓' : i + 1}</span>
                                <span className="ob-step-label">{s.label}</span>
                                <span className="ob-sr">{s.state === 'done' ? ' (done)' : s.state === 'current' ? ' (current step)' : ' (locked)'}</span>
                            </li>
                        ))}
                    </ol>
                    {cur && (
                        <div className="ob-current" aria-live="polite">
                            <div>
                                <div className="ob-current-title">{cur.title}</div>
                                <p className="ob-current-text">{cur.text}</p>
                            </div>
                            <Link to={cur.cta.to} className="aa-btn is-primary">{cur.cta.label}</Link>
                        </div>
                    )}
                </div>
            )}
        </section>
    )
}

/**
 * The guide's next action as one primary button, for empty states. Falls back to `fallback`
 * ({to, label}) while data loads or for ineligible users.
 */
export function GuideNextCta({ fallback }) {
    const g = useAAGuide()
    const cta = g.ready && g.eligible && g.current ? g.current.cta : fallback
    if (!cta) return null
    return <Link to={cta.to} className="aa-btn is-primary">{cta.label}</Link>
}

/** One-line hint matching GuideNextCta: the current step's title, or `fallback`. */
export function useGuideNextTitle(fallback) {
    const g = useAAGuide()
    return g.ready && g.eligible && g.current ? g.current.title : fallback
}

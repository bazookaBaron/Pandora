import { Link } from 'react-router-dom'
import { useAAGuide } from './useAAGuide'
import './onboarding.css'

// Collapse the 8 server-derived guide steps into 5 compact timeline steps.
const GROUPS = [
    { id: 'profile', label: 'Profile', ids: ['resume', 'answers', 'prefs'] },
    { id: 'email', label: 'Email', ids: ['email', 'consent'] },
    { id: 'buy', label: 'Buy pack', ids: ['buy'] },
    { id: 'applying', label: 'Applying', ids: ['review'] },
    { id: 'results', label: 'Results', ids: ['track'] },
]

export function buildTimeline(g) {
    const byId = Object.fromEntries(g.steps.map((s) => [s.id, s]))
    const groups = GROUPS.map((grp) => {
        const parts = grp.ids.map((id) => byId[id])
        const open = parts.find((p) => p.state !== 'done')
        return { id: grp.id, label: grp.label, done: !open && grp.id !== 'results', cta: (open || parts[0]).cta }
    })
    const cur = groups.findIndex((x) => !x.done)
    return groups.map((x, i) => ({ ...x, state: x.done ? 'done' : i === cur ? 'current' : 'todo' }))
}

/**
 * Compact AutoApply timeline for the Overview (horizontal; vertical on phones). State comes from
 * the server (see useAAGuide). The current step has one action button; once everything before
 * "Results" is done it collapses to a single slim line. Renders nothing for ineligible users.
 */
export default function AAProgressGuide({ style }) {
    const g = useAAGuide()
    if (!g.ready || !g.eligible) return null
    const steps = buildTimeline(g)
    const cur = steps.find((s) => s.state === 'current')

    if (!cur || cur.id === 'results') {
        return (
            <p className="ob-slim" role="status" style={style}>
                <span className="ob-slim-dot" aria-hidden>✓</span>
                Setup complete. We are applying; results land in your Inbox.
            </p>
        )
    }

    return (
        <section className="ob-guide" aria-label="AutoApply progress" style={style}>
            <ol className="ob-steps">
                {steps.map((s, i) => (
                    <li key={s.id} className={`ob-step is-${s.state}`} aria-current={s.state === 'current' ? 'step' : undefined}>
                        <span className="ob-dot" aria-hidden>{s.state === 'done' ? '✓' : i + 1}</span>
                        <span className="ob-step-label">{s.label}</span>
                        <span className="ob-sr">{s.state === 'done' ? ' (done)' : s.state === 'current' ? ' (current step)' : ' (to do)'}</span>
                        {s.state === 'current' && <Link to={s.cta.to} className="aa-btn is-primary ob-step-cta">{s.cta.label}</Link>}
                    </li>
                ))}
            </ol>
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

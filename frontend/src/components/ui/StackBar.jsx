import { num } from '../../lib/format'

/**
 * Stacked horizontal bar of parts out of a total, each part in a tone. Zero parts are skipped.
 *
 *   <StackBar total={50} legend segments={[
 *       { key: 'applied', label: 'Applied', value: 20, tone: 'success' },
 *       { key: 'queued',  label: 'Queued',  value: 12, tone: 'waiting' },
 *   ]} />
 *
 * `label` overrides the generated aria-label ("20 applied, 12 queued of 50").
 */
export default function StackBar({ segments = [], total, legend = false, label, className = '' }) {
    const parts = segments.filter((s) => Number(s.value) > 0)
    const sum = segments.reduce((n, s) => n + (Number(s.value) || 0), 0)
    const denom = Math.max(Number(total) || 0, sum, 1)
    const aria = label || `${segments.map((s) => `${num(s.value || 0)} ${String(s.label).toLowerCase()}`).join(', ')}${total != null ? ` of ${num(total)}` : ''}`
    return (
        <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="sys-stackbar" role="img" aria-label={aria}>
                {parts.map((s) => (
                    <span key={s.key || s.label} className={`tone-${s.tone || 'history'}`} style={{ width: `${(Number(s.value) / denom) * 100}%` }} />
                ))}
            </div>
            {legend && parts.length > 0 && (
                <ul className="sys-legend" aria-hidden="true">
                    {parts.map((s) => <li key={s.key || s.label}><i className={`tone-${s.tone || 'history'}`} />{s.label} {num(s.value)}</li>)}
                </ul>
            )}
        </div>
    )
}

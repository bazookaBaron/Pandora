import { num } from '../../lib/format'

/**
 * Progress bar with role="progressbar". Default fill is the brand gradient; pass `tone` for a flat semantic colour.
 *
 *   <Progress value={3} max={5} label="Referral posts used" />                 // bar + "3 / 5 used · 60%"
 *   <Progress value={8} max={10} tone="danger" thin showText={false} label="Quota" />
 *   <Progress value={40} max={100} text="40% ready" label="Profile readiness" />
 *
 * Props: value, max, label (aria-label; always pass one), tone, thin, showText (default true),
 *        text (overrides the left caption), unit (default 'used').
 */
export default function Progress({ value = 0, max = 0, label = 'Progress', tone, thin = false, showText = true, text, unit = 'used', className = '', style }) {
    const v = Math.max(0, Number(value) || 0)
    const m = Math.max(0, Number(max) || 0)
    const pct = m > 0 ? Math.min(100, Math.round((v / m) * 100)) : 0
    return (
        <div className={className} style={style}>
            <div
                className={`sys-progress${tone ? ` is-toned tone-${tone}` : ''}${thin ? ' is-thin' : ''}`}
                role="progressbar"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={m}
                aria-valuenow={m > 0 ? Math.min(v, m) : v}
            >
                <span style={{ width: `${pct}%` }} />
            </div>
            {showText && (
                <div className="sys-progress-meta">
                    <span>{text ?? `${num(v)} / ${num(m)} ${unit}`}</span>
                    <span>{pct}%</span>
                </div>
            )}
        </div>
    )
}

/**
 * Status pill (.sys-pill). Colour = semantic `tone`.
 *
 *   <Pill tone="success">Applied</Pill>
 *   <Pill tone="active" live>Running</Pill>          // pulsing dot (motion-safe)
 *   <Pill tone="danger" icon={AlertTriangle} soft>Failed</Pill>
 *
 * tone: active | success | attention | waiting | history (default) | danger | plan
 * live: pulsing dot before the label      soft: faint border instead of a full currentColor border
 * icon: lucide component, 11px            title / aria-label / className passed through
 *
 * For a status -> [label, tone] lookup, see StatusPill below.
 */
export default function Pill({ tone = 'history', live = false, soft = false, icon: Icon, children, className = '', ...rest }) {
    return (
        <span className={`sys-pill tone-${tone}${soft ? ' is-soft' : ''} ${className}`.trim()} {...rest}>
            {live && <span className="sys-dot" aria-hidden="true" />}
            {Icon && <Icon size={11} aria-hidden="true" />}
            {children}
        </span>
    )
}

/**
 * Map-driven pill: `map` is { status: [label, tone, live?] }; unknown statuses render de-snaked in history tone.
 *
 *   const REFERRAL = { open: ['Open', 'active'], accepted: ['Accepted', 'success'] }
 *   <StatusPill map={REFERRAL} status={r.status} />
 */
export function StatusPill({ map, status, ...rest }) {
    const [label, tone, live] = (map && map[status]) || [String(status || 'unknown').replace(/_/g, ' '), 'history']
    return <Pill tone={tone} live={!!live} {...rest}>{label}</Pill>
}

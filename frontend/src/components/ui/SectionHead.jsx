import { num } from '../../lib/format'

/**
 * Section header: tinted icon chip + uppercase title + optional count pill, right-aligned action and a sub line.
 * Colour comes from `tone` (active | success | attention | waiting | history | danger | plan).
 *
 *   <SectionHead icon={Briefcase} title="Open roles" tone="active" count={128}
 *                action={<Button size="sm">Subscribe</Button>} sub="Updated hourly" id="jobs-h" />
 *
 * Pair `id` with `aria-labelledby` on the surrounding <section>.
 */
export default function SectionHead({ icon: Icon, title, tone = 'history', count, sub, action, id, as: H = 'h2', className = '' }) {
    return (
        <div className={`sys-sec-head tone-${tone}${Icon ? '' : ' no-icon'} ${className}`.trim()}>
            {Icon && <span className="sys-sec-icon" aria-hidden="true"><Icon size={15} strokeWidth={2.2} /></span>}
            <H id={id} className="sys-sec-title">{title}</H>
            {count != null && <span className="sys-sec-count">{typeof count === 'number' ? num(count) : count}</span>}
            {action && <span className="sys-sec-action">{action}</span>}
            {sub && <p className="sys-sec-sub">{sub}</p>}
        </div>
    )
}

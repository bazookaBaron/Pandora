import { BadgeCheck } from 'lucide-react'
import { Pill } from '../../components/ui'

// Shared bits for the referral rows and sheets: the status map, the verified
// badge, the monthly quota pill and a label / value line. Colour is for status only.

export function isUnlimited(limit) {
    return limit === 'unlimited' || limit === Infinity || !Number.isFinite(Number(limit))
}

// status -> [label, tone]; tone is a Row metaTone / .tone-* suffix.
export const REFERRAL_STATUS = {
    open: ['Open', 'active'],
    accepted: ['Accepted', 'success'],
    expired: ['Expired', 'waiting'],
    cancelled: ['Cancelled', 'history'],
}
export const statusLabel = (status) => (REFERRAL_STATUS[status] || [])[0] || status
export const statusTone = (status) => (REFERRAL_STATUS[status] || [])[1] || 'history'

export function VerifiedBadge({ company }) {
    return (
        <Pill tone="success" soft icon={BadgeCheck} title="This person confirmed a work email at this company.">
            Verified{company ? ` at ${company}` : ''}
        </Pill>
    )
}

/** "2 of 3 left" pill for this month's referral requests. */
export function QuotaPill({ usage }) {
    if (!usage) return null
    if (isUnlimited(usage.limit)) return <Pill tone="success" soft>Unlimited</Pill>
    const used = Number(usage.used ?? 0)
    const limit = Number(usage.limit) || 0
    const left = Math.max(0, limit - used)
    return (
        <Pill tone={left === 0 ? 'danger' : 'success'} soft title="Referral requests left this month">
            {left} of {limit} left
        </Pill>
    )
}

/** One label / value line inside a details sheet. Renders nothing without a value. */
export function Fact({ label, children }) {
    if (children == null || children === '' || children === false) return null
    return (
        <div className="rf-fact">
            <span className="rf-fact-label">{label}</span>
            <span className="rf-fact-value">{children}</span>
        </div>
    )
}

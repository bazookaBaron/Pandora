import { BadgeCheck } from 'lucide-react'
import { Pill, Progress } from '../../components/ui'
import { fmtShortDate } from '../../lib/format'

// Shared bits for the referral cards: neutral fact chips, the status pill map,
// the verified badge and the monthly quota bar. Colour is used for status only.

export function isUnlimited(limit) {
    return limit === 'unlimited' || limit === Infinity || !Number.isFinite(Number(limit))
}

// status -> [label, tone]; also the card's left-border tone.
export const REFERRAL_STATUS = {
    open: ['Open', 'active'],
    accepted: ['Accepted', 'success'],
    expired: ['Expired', 'waiting'],
    cancelled: ['Cancelled', 'history'],
}
export const statusTone = (status) => (REFERRAL_STATUS[status] || [])[1] || 'history'

// A neutral fact chip (company, job id, role, years). `icon` is a lucide component.
export function Chip({ icon: Icon, label, title, children }) {
    return (
        <span className="sys-chip" title={title}>
            {Icon && <Icon size={12} aria-hidden="true" />}
            {label && <span className="ref-chip-label">{label}</span>}
            <span className="sys-chip-text">{children}</span>
        </span>
    )
}

export function VerifiedBadge({ company }) {
    return (
        <Pill tone="success" soft icon={BadgeCheck} title="This person confirmed a work email at this company.">
            Verified{company ? ` at ${company}` : ''}
        </Pill>
    )
}

export function QuotaLine({ usage }) {
    if (!usage) return null
    if (isUnlimited(usage.limit)) {
        return (
            <div className="ref-quota">
                <span className="ref-quota-text">Unlimited referral posts this month</span>
            </div>
        )
    }
    const used = Number(usage.used ?? 0)
    const limit = Number(usage.limit) || 0
    const resets = usage.resetsAt ? fmtShortDate(usage.resetsAt) : ''
    return (
        <div className="ref-quota">
            <Progress
                value={used}
                max={limit}
                label="Referral posts used this month"
                tone={limit > 0 && used >= limit ? 'danger' : undefined}
                text={`${used} / ${limit} posts this month${resets ? ` · resets ${resets}` : ''}`}
            />
        </div>
    )
}

import { useNavigate } from 'react-router-dom'
import { Bell, BellRing } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useEntitlements } from '../../lib/useEntitlements'
import { useCompanySubscriptions, useSubscribeToCompany, useUnsubscribeFromCompany } from '../../lib/useCompanySubscriptions'

// Per-card "subscribe to this company's job alerts" toggle — same feature and
// server-side gating as JobsCompanyPage's SubscribeButton (config/tiers.js:
// company_subscriptions_max, Pro/Max only), just icon-sized so it works
// inline on a job card without sending someone to the company's hub page
// first. Every card on a page shares the one `useCompanySubscriptions` query
// (react-query dedupes by key), so this is one network read, not N.
function BellButton({ on = false, label, onClick, disabled }) {
    const Icon = on ? BellRing : Bell
    return (
        <button type="button" title={label} aria-label={label} aria-pressed={on} onClick={onClick} disabled={disabled}
            className={`sys-btn sys-icon-btn is-ghost job-bell${on ? ' is-on' : ''}`}>
            <Icon size={14} aria-hidden="true" />
        </button>
    )
}

export default function SubscribeBell({ slug, companyName }) {
    const { user } = useAuth()
    const navigate = useNavigate()
    const { plan, isLoading: planLoading } = useEntitlements()
    const { data } = useCompanySubscriptions()
    const subscribe = useSubscribeToCompany()
    const unsubscribe = useUnsubscribeFromCompany()

    if (!slug) return null

    if (!user) {
        return (
            <BellButton label={`Log in to get alerts for ${companyName || 'this company'}`}
                onClick={(e) => { e.preventDefault(); navigate('/auth') }} />
        )
    }
    if (planLoading) return <span className="job-bell-slot" aria-hidden="true" />

    if (plan === 'free') {
        return (
            <BellButton label="Upgrade to Pro or Max to get job alerts for this company"
                onClick={(e) => { e.preventDefault(); navigate('/pricing') }} />
        )
    }

    const subscriptions = data?.subscriptions || []
    const limit = data?.limit === 'unlimited' ? Infinity : Number(data?.limit ?? 0)
    const isSubscribed = subscriptions.some((s) => s.company_slug === slug)
    const atCap = !isSubscribed && Number.isFinite(limit) && subscriptions.length >= limit
    const busy = subscribe.isPending || unsubscribe.isPending
    const disabled = busy || (atCap && !isSubscribed)

    const toggle = async (e) => {
        e.preventDefault()
        if (disabled) return
        try {
            if (isSubscribed) await unsubscribe.mutateAsync(slug)
            else await subscribe.mutateAsync({ companySlug: slug, companyName: companyName || slug })
        } catch {
            /* the global mutation toast explains the failure (e.g. the plan's alert cap) */
        }
    }

    const label = isSubscribed
        ? `Subscribed to ${companyName || slug} — click to unsubscribe`
        : atCap
            ? `Limit reached (${subscriptions.length}/${limit}) — manage on your profile`
            : `Get emailed when ${companyName || 'this company'} posts new roles`

    return <BellButton on={isSubscribed} label={label} onClick={toggle} disabled={disabled} />
}

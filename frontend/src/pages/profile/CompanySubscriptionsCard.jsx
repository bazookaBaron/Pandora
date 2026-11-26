import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell, Lock } from 'lucide-react'
import { useEntitlements } from '../../lib/useEntitlements'
import { useCompanySubscriptions, useUnsubscribeFromCompany } from '../../lib/useCompanySubscriptions'
import { UpgradeButton } from '../../components/shared/PaywallGate'
import { SectionHead, Progress, InlineConfirm, Button } from '../../components/ui'
import Skeleton from './Skeleton'

// Pro/Max users subscribe to companies from /jobs/company/:slug; this card
// lists + removes those subscriptions. Free users (limit 0) see a locked upsell.
export default function CompanySubscriptionsCard() {
    const { plan, isLoading: planLoading } = useEntitlements()
    const { data, isLoading, error } = useCompanySubscriptions()
    const unsubscribe = useUnsubscribeFromCompany()
    const [removingSlug, setRemovingSlug] = useState(null)
    const [confirmSlug, setConfirmSlug] = useState(null)

    const subscriptions = data?.subscriptions || []
    const limit = data?.limit === 'unlimited' ? Infinity : Number(data?.limit ?? 0)
    const used = data?.used ?? subscriptions.length

    const handleRemove = async (slug) => {
        if (removingSlug) return
        setRemovingSlug(slug)
        try {
            await unsubscribe.mutateAsync(slug)
        } catch {
            /* rolled back in the hook; the global mutation toast shows why */
        } finally {
            setRemovingSlug(null)
            setConfirmSlug(null)
        }
    }

    const head = (count) => (
        <SectionHead icon={Bell} title="Job alerts" tone="attention" id="pf-alerts-h" count={count}
            sub={plan === 'free' || planLoading ? null : 'Daily email when these companies post new roles.'} />
    )

    if (planLoading) {
        return (
            <section className="card profile-card" aria-labelledby="pf-alerts-h">
                {head()}
                <Skeleton rows={1} />
            </section>
        )
    }

    if (plan === 'free') {
        return (
            <section className="card profile-card" aria-labelledby="pf-alerts-h">
                {head()}
                <div className="sys-locked profile-locked">
                    <Lock size={16} className="sys-locked-icon" aria-hidden="true" />
                    <span className="sys-locked-title">Company job alerts are a Pro feature.</span>
                    <UpgradeButton size="sm">Unlock</UpgradeButton>
                </div>
            </section>
        )
    }

    return (
        <section className="card profile-card" aria-labelledby="pf-alerts-h">
            {head(used)}
            {Number.isFinite(limit) && limit > 0 && (
                <Progress value={used} max={limit} thin label="Job alert slots used" className="profile-quota" />
            )}

            {isLoading ? (
                <Skeleton rows={2} />
            ) : error ? (
                <p className="sys-note is-danger" role="alert">Couldn&apos;t load your alerts — try refreshing.</p>
            ) : subscriptions.length === 0 ? (
                <p className="profile-empty">None yet. Subscribe from a company&apos;s jobs page.</p>
            ) : (
                <ul className="sys-list">
                    {subscriptions.map((s) => (
                        <li key={s.company_slug}>
                            {confirmSlug === s.company_slug ? (
                                <InlineConfirm
                                    message={`Stop alerts for ${s.company_name}?`}
                                    confirmLabel="Remove"
                                    busy={removingSlug === s.company_slug}
                                    onConfirm={() => handleRemove(s.company_slug)}
                                    onCancel={() => setConfirmSlug(null)}
                                />
                            ) : (
                                <div className="sys-row tone-attention">
                                    <Link to={`/jobs/company/${s.company_slug}`} className="sys-row-main profile-row-link">{s.company_name}</Link>
                                    <Button variant="ghost" onClick={() => setConfirmSlug(s.company_slug)} aria-label={`Remove ${s.company_name}`}>
                                        Remove
                                    </Button>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    )
}

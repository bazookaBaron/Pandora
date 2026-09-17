import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import Navbar from '../../components/Navbar'
import { useJobsCompany } from '../../lib/useJobs'
import { LoadingState, ErrorState, EmptyState } from '../../components/shared/states'
import { useAuth } from '../../contexts/AuthContext'
import { useEntitlements } from '../../lib/useEntitlements'
import { useCompanySubscriptions, useSubscribeToCompany, useUnsubscribeFromCompany } from '../../lib/useCompanySubscriptions'
import { UpgradeButton } from '../../components/shared/PaywallGate'

// "Subscribe to <Company>" — job-alert subscriptions are a Pro/Max feature
// (config/tiers.js: company_subscriptions_max). Free/logged-out visitors see
// a locked upsell affordance instead of the toggle, mirroring the PaywallGate
// pattern used elsewhere rather than a bespoke gate.
function SubscribeButton({ slug, companyName }) {
    const { user } = useAuth()
    const { plan, isLoading: planLoading } = useEntitlements()
    const { data } = useCompanySubscriptions()
    const subscribe = useSubscribeToCompany()
    const unsubscribe = useUnsubscribeFromCompany()
    const [err, setErr] = useState('')

    if (!user) {
        return (
            <Link to="/auth" style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px',
                borderRadius: 8, border: '1px solid var(--subtle)', color: 'var(--accent)',
                fontSize: '0.78rem', fontWeight: 700, textDecoration: 'none', flexShrink: 0,
            }}>
                Log in to subscribe for alerts
            </Link>
        )
    }

    if (planLoading) return null

    if (plan === 'free') {
        return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                <span style={{ color: 'var(--muted)', fontSize: '0.72rem', maxWidth: 200 }}>
                    Get emailed when {companyName || 'this company'} posts new roles
                </span>
                <UpgradeButton size="sm">Unlock job alerts</UpgradeButton>
            </div>
        )
    }

    const subscriptions = data?.subscriptions || []
    const limit = data?.limit === 'unlimited' ? Infinity : Number(data?.limit ?? 0)
    const isSubscribed = subscriptions.some((s) => s.company_slug === slug)
    const atCap = !isSubscribed && Number.isFinite(limit) && subscriptions.length >= limit
    const busy = subscribe.isPending || unsubscribe.isPending

    const toggle = async () => {
        setErr('')
        try {
            if (isSubscribed) {
                await unsubscribe.mutateAsync(slug)
            } else {
                await subscribe.mutateAsync({ companySlug: slug, companyName: companyName || slug })
            }
        } catch (e) {
            setErr(e?.body?.error === 'usage_limit' || e?.code === 'usage_limit'
                ? `You've reached your plan's limit of ${limit} company subscriptions.`
                : e?.message || 'Something went wrong.')
        }
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
            <button
                type="button"
                onClick={toggle}
                disabled={busy || (atCap && !isSubscribed)}
                title={atCap && !isSubscribed ? `Limit reached (${subscriptions.length}/${limit})` : undefined}
                style={{
                    padding: '8px 16px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 700,
                    cursor: busy || (atCap && !isSubscribed) ? 'not-allowed' : 'pointer',
                    opacity: busy || (atCap && !isSubscribed) ? 0.6 : 1,
                    border: isSubscribed ? '1px solid var(--subtle)' : 'none',
                    background: isSubscribed ? 'transparent' : 'linear-gradient(135deg, #22d3ee, #a78bfa)',
                    color: isSubscribed ? 'var(--accent)' : 'var(--surface)',
                }}
            >
                {busy ? 'Saving…' : isSubscribed ? 'Subscribed ✓' : atCap ? `Limit reached (${subscriptions.length}/${limit})` : `Subscribe for alerts`}
            </button>
            {err && <span style={{ color: '#f87171', fontSize: '0.68rem', maxWidth: 220, textAlign: 'right' }}>{err}</span>}
        </div>
    )
}

// Programmatic per-company jobs hub (/jobs/company/:slug) — P1 "page factory".
// Server decides the robots directive (see server.js's getJobsCompanyPayload +
// lib/seoHead.js's evaluateJobHubIndexability); this page just renders
// whatever it gets, curated or not, so a company short on evidence still has
// a real, useful page for the visitors who do land on it.
export default function JobsCompanyPage() {
    const { slug } = useParams()
    const { data, isLoading, error, refetch } = useJobsCompany(slug)
    const { company, postings, eligible } = data

    return (
        <>
            <Navbar />
            <div className="has-tilebar" style={{ paddingTop: 56 }}>
                <div style={{ borderBottom: '1px solid var(--subtle)', background: 'var(--surface-2)' }}>
                    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 16px' }}>
                        <Link to="/" style={{ fontSize: '0.72rem', color: 'var(--muted)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 12 }}>
                            ← All Jobs
                        </Link>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', justifyContent: 'space-between' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                                <div style={{
                                    width: 48, height: 48, borderRadius: 10, background: 'var(--panel)',
                                    border: '2px solid var(--subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontSize: '1.2rem', fontWeight: 900, color: '#22d3ee', flexShrink: 0,
                                }}>
                                    {(company?.name || slug || '?').charAt(0).toUpperCase()}
                                </div>
                                <div>
                                    <h1 style={{ fontSize: '1.3rem', fontWeight: 900, letterSpacing: '-0.03em', color: 'var(--bright)' }}>
                                        {company?.name || slug} Jobs
                                    </h1>
                                    <p style={{ color: 'var(--muted)', fontSize: '0.78rem', marginTop: 2 }}>
                                        {postings.length > 0
                                            ? `${postings.length} open position${postings.length === 1 ? '' : 's'}, crawled directly from their careers page and refreshed through the day.`
                                            : 'Crawled directly from their careers page and refreshed through the day.'}
                                    </p>
                                </div>
                            </div>
                            {!isLoading && !error && company && (
                                <SubscribeButton slug={slug} companyName={company.name} />
                            )}
                        </div>
                        {!isLoading && !error && !eligible && (
                            <p style={{ color: 'var(--faint)', fontSize: '0.7rem', marginTop: 10 }}>
                                This page isn't submitted for search indexing yet — it's still real and linkable, just not part of the curated launch set.
                            </p>
                        )}
                    </div>
                </div>

                <div style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 16px' }}>
                    {isLoading && <LoadingState label="Loading open roles…" />}
                    {error && (
                        <ErrorState
                            title={error.status === 404 ? 'Unknown company' : 'Something went wrong'}
                            message={error.status === 404 ? `We don't have a jobs page for "${slug}".` : undefined}
                            err={error.status === 404 ? null : error}
                            onRetry={error.status === 404 ? undefined : refetch}
                        />
                    )}
                    {!isLoading && !error && postings.length === 0 && (
                        <EmptyState
                            icon="🗂️"
                            title="No open roles right now"
                            message="This company doesn't have any postings in the last 24 hours — check back soon."
                        />
                    )}
                    {!isLoading && !error && postings.length > 0 && (
                        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {postings.map((job) => (
                                <li key={job.id} style={{
                                    border: '1px solid var(--subtle)', borderRadius: 10, padding: '14px 16px',
                                    background: 'var(--panel)', display: 'flex', flexWrap: 'wrap',
                                    alignItems: 'center', justifyContent: 'space-between', gap: 10,
                                }}>
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ fontWeight: 800, color: 'var(--bright)', fontSize: '0.92rem' }}>{job.title}</div>
                                        <div style={{ color: 'var(--muted)', fontSize: '0.76rem', marginTop: 2 }}>
                                            {[job.location, job.locationType, job.seniority].filter(Boolean).join(' · ')}
                                        </div>
                                    </div>
                                    <a
                                        href={job.url}
                                        target="_blank"
                                        rel="noopener noreferrer nofollow"
                                        style={{
                                            flexShrink: 0, padding: '6px 14px', borderRadius: 6,
                                            border: '1px solid var(--subtle)', color: '#22d3ee',
                                            fontSize: '0.78rem', fontWeight: 700, textDecoration: 'none',
                                        }}
                                    >
                                        View & Apply →
                                    </a>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </>
    )
}

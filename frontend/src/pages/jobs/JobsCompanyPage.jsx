import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Bell, BellRing, Briefcase } from 'lucide-react'
import Navbar from '../../components/Navbar'
import { useJobsCompany } from '../../lib/useJobs'
import { LoadingState, ErrorState, EmptyState } from '../../components/shared/states'
import { useAuth } from '../../contexts/AuthContext'
import { useEntitlements } from '../../lib/useEntitlements'
import { useCompanySubscriptions, useSubscribeToCompany, useUnsubscribeFromCompany } from '../../lib/useCompanySubscriptions'
import { UpgradeButton } from '../../components/shared/PaywallGate'
import { Button, SectionHead } from '../../components/ui'
import JobCard from './JobCard'

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
        return <Button to="/auth" icon={Bell}>Log in for alerts</Button>
    }

    if (planLoading) return null

    if (plan === 'free') {
        return (
            <div className="jobs-co-sub-row">
                <span className="jobs-co-sub-hint">
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
        <div className="jobs-co-sub">
            <Button
                variant={isSubscribed ? 'secondary' : 'primary'}
                icon={isSubscribed ? BellRing : Bell}
                onClick={toggle}
                busy={busy}
                busyLabel="Saving…"
                disabled={atCap && !isSubscribed}
                aria-pressed={isSubscribed}
                title={atCap && !isSubscribed ? `Limit reached (${subscriptions.length}/${limit})` : undefined}
            >
                {isSubscribed ? 'Subscribed' : atCap ? `Limit reached (${subscriptions.length}/${limit})` : 'Subscribe for alerts'}
            </Button>
            {err && <span className="jobs-co-err" role="alert">{err}</span>}
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
                <div className="jobs-co-head">
                    <div className="jobs-co-wrap">
                        <Link to="/" className="jobs-co-back">
                            <ArrowLeft size={13} aria-hidden="true" /> All jobs
                        </Link>
                        <div className="jobs-co-row">
                            <div className="jobs-co-id">
                                <div className="jobs-co-logo" aria-hidden="true">
                                    {(company?.name || slug || '?').charAt(0).toUpperCase()}
                                </div>
                                <div style={{ minWidth: 0 }}>
                                    <h1 className="pg-title">
                                        {company?.name || slug} Jobs
                                    </h1>
                                    <p className="pg-subtitle">
                                        {postings.length > 0
                                            ? `${postings.length} open position${postings.length === 1 ? '' : 's'}, crawled from their careers page.`
                                            : 'Crawled from their careers page through the day.'}
                                    </p>
                                </div>
                            </div>
                            {!isLoading && !error && company && (
                                <SubscribeButton slug={slug} companyName={company.name} />
                            )}
                        </div>
                        {!isLoading && !error && !eligible && (
                            <p className="jobs-co-note">
                                This page isn't submitted for search indexing yet — it's still real and linkable, just not part of the curated launch set.
                            </p>
                        )}
                    </div>
                </div>

                <div className="jobs-co-wrap">
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
                            art="jobs"
                            title="No open roles right now"
                            message="This company doesn't have any postings in the last 24 hours — check back soon."
                        />
                    )}
                    {!isLoading && !error && postings.length > 0 && (
                        <section aria-labelledby="jobs-co-h">
                            <SectionHead id="jobs-co-h" icon={Briefcase} tone="active" title="Open roles" count={postings.length} />
                            <ul className="job-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                                {postings.map((job) => (
                                    <li key={job.id} style={{ minWidth: 0 }}>
                                        <JobCard j={job} showCompany={false} showBell={false} rel="noopener noreferrer nofollow" />
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                </div>
            </div>
        </>
    )
}

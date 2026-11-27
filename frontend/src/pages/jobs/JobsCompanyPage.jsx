import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Bell, BellRing, Lock } from 'lucide-react'
import Navbar from '../../components/Navbar'
import { PageContainer } from '../../components/shared/Layout'
import { useJobsCompany } from '../../lib/useJobs'
import { useCompanies } from '../../lib/useCompanies'
import { LoadingState, ErrorState, EmptyState } from '../../components/shared/states'
import { useAuth } from '../../contexts/AuthContext'
import { useEntitlements } from '../../lib/useEntitlements'
import { useCompanySubscriptions, useSubscribeToCompany, useUnsubscribeFromCompany } from '../../lib/useCompanySubscriptions'
import { CTA } from '../../lib/copy'
import { track, TRACK } from '../../lib/track'
import { NextStep, PageHeader } from '../../components/ui'
import JobRow from './JobRow'
import JobSheet from './JobSheet'
import { JobLogo } from './jobsShared'

const trackSub = (state) => track(TRACK.CTA_CLICK, { id: 'company_subscribe', section: 'jobs', state })

// "Subscribe" (job alerts) is a Pro/Max feature (config/tiers.js:
// company_subscriptions_max). Signed-out visitors go to sign in, free users
// to pricing; the server enforces the plan cap either way.
function SubscribeButton({ slug, companyName }) {
    const { user } = useAuth()
    const { plan, isLoading: planLoading } = useEntitlements()
    const { data } = useCompanySubscriptions()
    const subscribe = useSubscribeToCompany()
    const unsubscribe = useUnsubscribeFromCompany()
    const [err, setErr] = useState('')

    if (!user) {
        return (
            <Link to="/auth" className="sys-tone-btn" onClick={() => trackSub('signin')}>
                <Bell size={16} aria-hidden="true" /><span>Get job alerts</span>
            </Link>
        )
    }
    if (planLoading) return null
    if (plan === 'free') {
        return (
            <Link to="/pricing" className="sys-tone-btn" onClick={() => trackSub('upgrade')}
                title="Job alerts are part of Pro and Max">
                <Lock size={16} aria-hidden="true" /><span>Get job alerts</span>
            </Link>
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
                trackSub('subscribe')
                await subscribe.mutateAsync({ companySlug: slug, companyName: companyName || slug })
            }
        } catch (e) {
            setErr(e?.body?.error === 'usage_limit' || e?.code === 'usage_limit'
                ? `Your plan allows ${limit} company alerts.`
                : e?.message || 'Something went wrong.')
        }
    }

    const Icon = isSubscribed ? BellRing : Bell
    return (
        <div className="jobs-co-sub">
            <button type="button" className={`sys-tone-btn${isSubscribed ? ' jobs-sub-on' : ''}`} onClick={toggle}
                disabled={busy || atCap} aria-busy={busy || undefined} aria-pressed={isSubscribed}
                title={atCap ? `Limit reached (${subscriptions.length}/${limit})` : undefined}>
                {busy ? <span className="sys-spin" aria-hidden="true" /> : <Icon size={16} aria-hidden="true" />}
                <span>{isSubscribed ? 'Subscribed' : atCap ? `Limit reached (${subscriptions.length}/${limit})` : 'Subscribe'}</span>
            </button>
            {err && <span className="jobs-co-err" role="alert">{err}</span>}
        </div>
    )
}

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

// Prepare bridge: a company DSA list only when the DSA catalogue knows this
// company (same names as the DSA company filter); otherwise the general list.
function DsaBridge({ name }) {
    const { data: companies = [], isLoading, isError } = useCompanies()
    if (isLoading || !name) return null
    const key = normName(name)
    const match = !isError && key ? companies.find((c) => normName(c) === key) : null
    return match ? (
        <NextStep id={`jobsco-dsa-${normName(match)}`} section="prepare"
            text={`Practice ${match} DSA questions`}
            cta={{ label: CTA.startPractice, to: `/dsa/company/${encodeURIComponent(match)}` }} />
    ) : (
        <NextStep id="jobsco-dsa" section="prepare"
            text="Practice the DSA questions tech interviews ask"
            cta={{ label: CTA.startPractice, to: '/dsa' }} />
    )
}

// Programmatic per-company jobs hub (/jobs/company/:slug). The server decides
// the robots directive (server.js getJobsCompanyPayload + lib/seoHead.js
// evaluateJobHubIndexability); this page renders whatever it gets.
export default function JobsCompanyPage() {
    const { slug } = useParams()
    const { data, isLoading, error, refetch } = useJobsCompany(slug)
    const { company, postings } = data
    const [job, setJob] = useState(null)
    const name = company?.name || slug
    const ready = !isLoading && !error
    const n = postings.length

    return (
        <>
            <Navbar />
            <PageContainer>
                <PageHeader
                    section="jobs"
                    className="jobs-co-ph"
                    back={{ to: '/', label: 'All jobs' }}
                    title={<><JobLogo name={name} size="lg" /><span className="jobs-co-name">{name} Jobs</span></>}
                    subtitle={ready ? (n > 0 ? `${n} open role${n === 1 ? '' : 's'}` : 'No open roles right now') : null}
                    action={ready && company ? <SubscribeButton slug={slug} companyName={company.name} /> : undefined}
                />

                {isLoading && <LoadingState label="Loading open roles…" />}
                {error && (
                    <ErrorState
                        title={error.status === 404 ? 'Unknown company' : 'Something went wrong'}
                        message={error.status === 404 ? `We don't have a jobs page for "${slug}".` : undefined}
                        err={error.status === 404 ? null : error}
                        onRetry={error.status === 404 ? undefined : refetch}
                    />
                )}
                {ready && n === 0 && (
                    <EmptyState art="jobs" title="No open roles right now" message="Check back soon." />
                )}
                {ready && n > 0 && (
                    <section aria-label={`Open roles at ${name}`}>
                        <ul className="sys-rows jobs-rows">
                            {postings.map((j) => (
                                <li key={j.id}><JobRow j={j} showCompany={false} onOpen={setJob} /></li>
                            ))}
                        </ul>
                    </section>
                )}
                {ready && company && <DsaBridge name={company.name} />}
            </PageContainer>
            <JobSheet job={job} onClose={() => setJob(null)} rel="noopener noreferrer nofollow" showBell={false} linkCompany={false} />
        </>
    )
}

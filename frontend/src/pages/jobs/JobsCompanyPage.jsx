import { useParams, Link } from 'react-router-dom'
import Navbar from '../../components/Navbar'
import { useJobsCompany } from '../../lib/useJobs'
import { LoadingState, ErrorState, EmptyState } from '../../components/shared/states'

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

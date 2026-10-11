import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import Navbar from '../../components/Navbar'
import { LoadingState, ErrorState, EmptyState } from '../../components/shared/states'
import { useTrendsIndex, useTrendsDay } from '../../lib/useJobs'
import { TRACKED_COMPANIES } from '../../../config/siteFacts.js'

// ── Daily tech-hiring reports ──────────────────────────────────────
// /trends lists every day the crawler snapshotted; /trends/:date is one
// day's report. Data: GET /api/trends(/:date), from the crawler's daily
// market snapshot. Numbers cover every tracked region (unlike the jobs
// board, which is US & India only).

function fmtDate(date, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
    const t = Date.parse(`${date}T00:00:00Z`)
    if (Number.isNaN(t)) return date || ''
    return new Date(t).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts })
}

const num = (n) => (Number(n) || 0).toLocaleString('en-US')

function pctChange(curr, prev) {
    if (!prev) return null
    return Math.round(((curr - prev) / prev) * 1000) / 10
}

function Delta({ curr, prev }) {
    const pct = pctChange(curr, prev)
    if (pct == null) return null
    const up = pct >= 0
    return (
        <span style={{
            marginLeft: 8, fontSize: '0.7rem', fontWeight: 800,
            color: up ? '#4ade80' : '#f472b6',
        }}>
            {up ? '▲' : '▼'} {Math.abs(pct)}%
        </span>
    )
}

const SEN = [['intern', 'Intern'], ['junior', 'Junior'], ['mid', 'Mid'], ['senior', 'Senior'], ['staff', 'Staff'], ['principal', 'Principal'], ['unknown', 'Unspecified']]
const WORK = [['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'Onsite'], ['unspecified', 'Unspecified']]
const COUNTRY = [['US', 'United States'], ['IN', 'India'], ['other', 'Other regions']]
const CTYPE = [['product', 'Product'], ['startup', 'Startup'], ['service', 'Service'], ['unknown', 'Unspecified']]

const panel = { background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '16px' }
const h2 = { fontSize: '0.9rem', fontWeight: 900, color: 'var(--bright)', letterSpacing: '-0.01em', margin: '0 0 12px' }

function Metric({ label, value, extra, accent }) {
    return (
        <div style={{ ...panel, padding: '12px 16px', flex: '1 1 170px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ fontSize: '1.5rem', fontWeight: 900, color: accent, letterSpacing: '-0.02em' }}>{value}</span>
                {extra}
            </div>
            <div style={{ fontSize: '0.66rem', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>
                {label}
            </div>
        </div>
    )
}

function BarList({ title, dict, order, color }) {
    const rows = order.map(([k, label]) => [label, Number(dict?.[k]) || 0]).filter(([, n]) => n > 0)
    const total = rows.reduce((a, [, n]) => a + n, 0)
    if (!total) return null
    return (
        <div style={panel}>
            <h3 style={{ ...h2, fontSize: '0.8rem', marginBottom: 10 }}>{title}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {rows.map(([label, n]) => {
                    const pct = Math.round((n / total) * 1000) / 10
                    return (
                        <div key={label}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.74rem', color: 'var(--accent)', marginBottom: 3 }}>
                                <span>{label}</span>
                                <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{num(n)} · {pct}%</span>
                            </div>
                            <div style={{ height: 6, borderRadius: 3, background: 'var(--subtle)' }}>
                                <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: color }} />
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}

function Shell({ children }) {
    return (
        <>
            <Navbar />
            <main className="wrap" style={{ maxWidth: 980, margin: '0 auto', padding: '72px 16px 48px' }}>
                {children}
            </main>
        </>
    )
}

// ── /trends ────────────────────────────────────────────────────────
export function TrendsIndexPage() {
    const { data, isLoading, error, refetch } = useTrendsIndex()
    const days = data.days || []
    const latest = days[0]

    return (
        <Shell>
            <header style={{ marginBottom: 20 }}>
                <h1 style={{ fontSize: '1.4rem', fontWeight: 900, color: 'var(--bright)', letterSpacing: '-0.03em' }}>
                    Tech hiring trends
                </h1>
                <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: 6, maxWidth: 680, lineHeight: 1.6 }}>
                    A report for every day: how many new tech roles were posted, how many are open, which levels
                    are in demand and which companies are hiring most. Tracked across {TRACKED_COMPANIES} companies' career pages.
                </p>
            </header>

            {isLoading ? <LoadingState label="Loading reports…" />
                : error ? <ErrorState err={error} onRetry={refetch} />
                    : !latest ? <EmptyState icon="📈" title="No reports yet" message="The first daily report appears after the crawler's next snapshot." />
                        : (
                            <>
                                <Link to={`/trends/${latest.date}`} style={{ ...panel, display: 'block', textDecoration: 'none', marginBottom: 22, borderColor: 'var(--pop)' }}>
                                    <div style={{ fontSize: '0.66rem', color: 'var(--pop)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Latest report</div>
                                    <div style={{ fontSize: '1.1rem', fontWeight: 900, color: 'var(--bright)', marginTop: 4 }}>
                                        {fmtDate(latest.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                                    </div>
                                    <div style={{ fontSize: '0.82rem', color: 'var(--accent)', marginTop: 6 }}>
                                        {num(latest.newPostings)} new postings · {num(latest.totalOpen)} open roles
                                        <Delta curr={latest.newPostings} prev={latest.prevNewPostings} />
                                    </div>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--pop)', fontWeight: 700, marginTop: 10 }}>Read the report →</div>
                                </Link>

                                <h2 style={h2}>All daily reports</h2>
                                <div style={{ ...panel, padding: 0 }}>
                                    {days.map((d, i) => (
                                        <Link key={d.date} to={`/trends/${d.date}`} style={{
                                            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                                            padding: '12px 16px', textDecoration: 'none',
                                            borderTop: i === 0 ? 'none' : '1px solid var(--subtle)',
                                        }}>
                                            <span style={{ color: 'var(--bright)', fontWeight: 700, fontSize: '0.84rem' }}>
                                                {fmtDate(d.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                                            </span>
                                            <span style={{ color: 'var(--muted)', fontSize: '0.76rem', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
                                                {num(d.newPostings)} new · {num(d.totalOpen)} open
                                                <Delta curr={d.newPostings} prev={d.prevNewPostings} />
                                            </span>
                                        </Link>
                                    ))}
                                </div>
                            </>
                        )}
        </Shell>
    )
}

// ── /trends/:date ──────────────────────────────────────────────────
export function TrendsDayPage() {
    const { date } = useParams()
    const { data, isLoading, error, refetch } = useTrendsDay(date)
    const day = data?.day
    const prev = data?.prev

    useEffect(() => {
        if (day) document.title = `Tech Hiring on ${fmtDate(day.date)}: ${num(day.newPostings)} New Postings | Vloombox`
    }, [day])

    if (isLoading) return <Shell><LoadingState label="Loading report…" /></Shell>
    if (error?.status === 404) {
        return (
            <Shell>
                <EmptyState icon="📅" title="No report for this day"
                    message="Reports exist only for days the crawler took a snapshot."
                    action={<Link to="/trends" style={{ color: 'var(--pop)', fontWeight: 700, fontSize: '0.85rem' }}>See all daily reports →</Link>} />
            </Shell>
        )
    }
    if (error || !day) return <Shell><ErrorState err={error} onRetry={refetch} /></Shell>

    const country = day.byCountry || {}
    const top = day.topCompanies || []
    const leader = top[0]

    return (
        <Shell>
            <nav aria-label="Breadcrumb" style={{ fontSize: '0.72rem', color: 'var(--muted)', marginBottom: 12 }}>
                <Link to="/trends" style={{ color: 'var(--muted)', textDecoration: 'none' }}>Trends</Link>
                <span aria-hidden> / </span>
                <span>{fmtDate(day.date)}</span>
            </nav>

            <header style={{ marginBottom: 18 }}>
                <h1 style={{ fontSize: '1.4rem', fontWeight: 900, color: 'var(--bright)', letterSpacing: '-0.03em' }}>
                    Tech hiring on {fmtDate(day.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                </h1>
                <p style={{ color: 'var(--accent)', fontSize: '0.88rem', marginTop: 8, maxWidth: 720, lineHeight: 1.65 }}>
                    {num(day.newPostings)} new tech roles were posted in the 24 hours before this snapshot, across{' '}
                    {num(day.totalOpen)} open roles at {TRACKED_COMPANIES} tracked companies
                    {country.US || country.IN ? <> ({num(country.US)} in the United States, {num(country.IN)} in India)</> : null}.
                    {leader ? <> {leader.company} posted the most, with {num(leader.newPostings)} new roles.</> : null}
                </p>
            </header>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 22 }}>
                <Metric label="New postings (24h)" value={num(day.newPostings)} accent="#22d3ee"
                    extra={prev && <Delta curr={day.newPostings} prev={prev.newPostings} />} />
                <Metric label="Open roles" value={num(day.totalOpen)} accent="#a78bfa"
                    extra={prev && <Delta curr={day.totalOpen} prev={prev.totalOpen} />} />
                {day.closedPostings > 0 && <Metric label="Closed (24h)" value={num(day.closedPostings)} accent="#f472b6" />}
            </div>

            <h2 style={h2}>Who's hiring for what</h2>
            <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', marginBottom: 22 }}>
                <BarList title="Seniority (open roles)" dict={day.bySeniority} order={SEN} color="#22d3ee" />
                <BarList title="Region (open roles)" dict={day.byCountry} order={COUNTRY} color="#a78bfa" />
                <BarList title="Work type (open roles)" dict={day.byWorkType} order={WORK} color="#4ade80" />
                <BarList title="Company type (open roles)" dict={day.byCompanyType} order={CTYPE} color="#f472b6" />
            </div>

            {top.length > 0 && (
                <>
                    <h2 style={h2}>Companies posting the most</h2>
                    <ol style={{ ...panel, listStyle: 'none', margin: '0 0 22px', padding: 0 }}>
                        {top.map((c, i) => (
                            <li key={c.company} style={{
                                display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 16px',
                                borderTop: i === 0 ? 'none' : '1px solid var(--subtle)', fontSize: '0.82rem',
                            }}>
                                <span style={{ color: 'var(--bright)', fontWeight: 700 }}>
                                    <span style={{ color: 'var(--muted)', fontWeight: 400, marginRight: 8 }}>{i + 1}.</span>{c.company}
                                </span>
                                <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{num(c.newPostings)} new</span>
                            </li>
                        ))}
                    </ol>
                </>
            )}

            <div style={{ ...panel, display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 18 }}>
                <span style={{ fontSize: '0.84rem', color: 'var(--accent)' }}>Looking for a role? The board lists today's US &amp; India postings.</span>
                <Link to="/" style={{ background: 'var(--pop)', color: '#09090b', fontWeight: 800, fontSize: '0.8rem', padding: '8px 14px', borderRadius: 8, textDecoration: 'none' }}>
                    Browse live jobs
                </Link>
            </div>

            <nav aria-label="More reports" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '0.8rem', fontWeight: 700 }}>
                {prev ? <Link to={`/trends/${prev.date}`} style={{ color: 'var(--pop)', textDecoration: 'none' }}>← {fmtDate(prev.date)}</Link> : <span />}
                <Link to="/trends" style={{ color: 'var(--muted)', textDecoration: 'none' }}>All reports</Link>
                {data.nextDate ? <Link to={`/trends/${data.nextDate}`} style={{ color: 'var(--pop)', textDecoration: 'none' }}>{fmtDate(data.nextDate)} →</Link> : <span />}
            </nav>
        </Shell>
    )
}

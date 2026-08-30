import { useEffect, useMemo, useState } from 'react'
import Navbar from '../../components/Navbar'
import { useJobs, useJobsAnalytics } from '../../lib/useJobs'
import { LoadingState, ErrorState, EmptyState } from '../../components/shared/states'

// ── helpers ────────────────────────────────────────────────────────
function relTime(iso) {
    if (!iso) return ''
    const t = new Date(iso).getTime()
    if (Number.isNaN(t)) return ''
    const s = (Date.now() - t) / 1000
    if (s < 90) return 'just now'
    if (s < 3600) return Math.round(s / 60) + 'm ago'
    if (s < 86400) return Math.round(s / 3600) + 'h ago'
    return Math.round(s / 86400) + 'd ago'
}

const LOC_TONE = { remote: '#4ade80', hybrid: '#22d3ee', onsite: '#f472b6' }
const SEN_TONE = {
    intern: '#a1a1aa', junior: '#38bdf8', mid: '#4ade80',
    senior: '#fbbf24', staff: '#fb923c', principal: '#f472b6', unknown: '#52525b',
}
const SEN_LABEL = {
    intern: 'Intern', junior: 'Junior (0–2y)', mid: 'Mid (2–4y)',
    senior: 'Senior (4–8y)', staff: 'Staff (8y+)', principal: 'Principal', unknown: 'Unspecified',
}

function Chip({ tone = '#a1a1aa', label, children }) {
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
            color: tone, background: tone + '14', border: `1px solid ${tone}33`,
            padding: '2px 8px', borderRadius: 999, fontSize: '0.68rem', fontWeight: 700, lineHeight: 1.5,
        }}>
            {label && <span style={{ opacity: 0.6, fontWeight: 600 }}>{label}</span>}
            {children}
        </span>
    )
}

// ── one job row ────────────────────────────────────────────────────
function JobCard({ j }) {
    const fresh = j.firstSeen && (Date.now() - new Date(j.firstSeen).getTime()) < 48 * 3600 * 1000
    const locTone = LOC_TONE[j.locationType] || '#a1a1aa'
    return (
        <div style={{
            background: '#161618', border: '1px solid #27272a', borderRadius: 10,
            padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                <a href={j.url} target="_blank" rel="noopener noreferrer" style={{
                    fontWeight: 900, fontSize: '0.88rem', color: '#fafafa', letterSpacing: '-0.01em',
                    textDecoration: 'none',
                }}>
                    {j.title || 'Untitled role'}
                </a>
                {j.company && <Chip tone="#38bdf8">{j.company}</Chip>}
                {j.location && <Chip tone="#a1a1aa">{j.location}</Chip>}
                {j.locationType && <Chip tone={locTone}>{j.locationType}</Chip>}
                {j.seniority && j.seniority !== 'unknown' && (
                    <Chip tone={SEN_TONE[j.seniority] || '#a1a1aa'}>{j.seniority}</Chip>
                )}
                {j.source && <Chip tone="#a78bfa" label="via">{j.source}</Chip>}
                {fresh && (
                    <span style={{
                        color: '#fbbf24', background: 'rgba(251,191,36,0.14)', border: '1px solid rgba(251,191,36,0.4)',
                        padding: '1px 7px', borderRadius: 999, fontSize: '0.56rem', fontWeight: 900,
                        textTransform: 'uppercase', letterSpacing: '0.07em',
                    }}>new</span>
                )}
                <span style={{ flex: 1 }} />
                <a href={j.url} target="_blank" rel="noopener noreferrer" style={{
                    padding: '5px 13px', borderRadius: 6, border: '1px solid rgba(34,211,238,0.4)',
                    color: '#22d3ee', fontSize: '0.74rem', fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap',
                }}>
                    Apply →
                </a>
            </div>
            <span style={{ fontSize: '0.64rem', color: '#52525b' }}>
                {j.firstSeen ? `First seen ${relTime(j.firstSeen)}` : ''}
                {j.lastSeen ? `${j.firstSeen ? ' · ' : ''}still live ${relTime(j.lastSeen)}` : ''}
            </span>
        </div>
    )
}

// ── controls ───────────────────────────────────────────────────────
function Segmented({ value, onChange, options, size = 'md' }) {
    const pad = size === 'sm' ? '3px 9px' : '4px 11px'
    return (
        <div style={{ display: 'inline-flex', background: '#161618', border: '1px solid #27272a', borderRadius: 8, padding: 3, gap: 2 }}>
            {options.map((o) => {
                const active = value === o.value
                return (
                    <button key={o.value || 'all'} type="button" onClick={() => onChange(o.value)} style={{
                        padding: pad, borderRadius: 6, border: 'none', cursor: 'pointer',
                        fontSize: '0.72rem', fontWeight: 700,
                        background: active ? '#27272a' : 'transparent',
                        color: active ? '#fafafa' : '#71717a',
                    }}>
                        {o.label}
                    </button>
                )
            })}
        </div>
    )
}

const selStyle = { flex: '0 1 150px', minWidth: 0 }

// ── charts (dependency-free) ───────────────────────────────────────
function BarRow({ label, value, max, tone }) {
    const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.74rem' }}>
            <span style={{ width: 130, flexShrink: 0, color: '#a1a1aa', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {label}
            </span>
            <div style={{ flex: 1, height: 16, background: '#161618', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: pct + '%', height: '100%', background: tone || '#22d3ee', opacity: 0.85, borderRadius: 4, transition: 'width .4s' }} />
            </div>
            <span style={{ width: 52, flexShrink: 0, color: '#fafafa', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {value.toLocaleString()}
            </span>
        </div>
    )
}

function BarChart({ title, rows, toneFor }) {
    if (!rows || !rows.length) return null
    const max = Math.max(...rows.map((r) => r.value), 1)
    return (
        <div style={{ background: '#161618', border: '1px solid #27272a', borderRadius: 10, padding: '14px 16px' }}>
            <h3 style={{ fontSize: '0.68rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#71717a', margin: '0 0 12px' }}>{title}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {rows.map((r) => <BarRow key={r.label} {...r} max={max} tone={toneFor ? toneFor(r) : r.tone} />)}
            </div>
        </div>
    )
}

function Metric({ label, value, accent }) {
    return (
        <div style={{ background: '#161618', border: '1px solid #27272a', borderRadius: 10, padding: '12px 16px', flex: '1 1 150px' }}>
            <div style={{ fontSize: '1.5rem', fontWeight: 900, color: accent || '#fafafa', letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
                {value}
            </div>
            <div style={{ fontSize: '0.66rem', color: '#71717a', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>
                {label}
            </div>
        </div>
    )
}

// ── Analytics tab ──────────────────────────────────────────────────
function AnalyticsView() {
    const { data, isLoading, error, refetch } = useJobsAnalytics(true)

    if (isLoading) return <LoadingState label="Crunching numbers…" />
    if (error) return <ErrorState err={error} onRetry={refetch} />
    if (data.notReady || data.total === 0) {
        return <EmptyState icon="📊" title="No data yet" message="Analytics populate once the crawler has indexed jobs." />
    }

    const senRows = (data.bySeniority || []).map((s) => ({
        label: SEN_LABEL[s.bucket] || s.bucket, value: s.count, tone: SEN_TONE[s.bucket] || '#a1a1aa',
    }))
    const wtRows = (data.byWorkType || []).map((w) => ({
        label: w.type === 'unspecified' ? 'Unspecified' : w.type[0].toUpperCase() + w.type.slice(1),
        value: w.count, tone: LOC_TONE[w.type] || '#52525b',
    }))
    const srcRows = (data.bySource || []).slice(0, 10).map((s) => ({ label: s.source, value: s.count, tone: '#a78bfa' }))
    const coRows = (data.topCompanies || []).slice(0, 12).map((c) => ({ label: c.company, value: c.count, tone: '#38bdf8' }))

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                <Metric label="Open postings" value={data.total.toLocaleString()} accent="#22d3ee" />
                <Metric label="Companies hiring" value={(data.companiesWithJobs ?? '—').toLocaleString?.() ?? '—'} />
                <Metric label="Mid-level (2–4y) share" value={data.midSharePct != null ? data.midSharePct + '%' : '—'} accent="#4ade80" />
            </div>

            <BarChart title="By seniority" rows={senRows} />
            <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
                <BarChart title="By work type" rows={wtRows} />
                {srcRows.length > 0 && <BarChart title="By source (ATS)" rows={srcRows} />}
            </div>
            {coRows.length > 0 && <BarChart title="Top companies by open roles" rows={coRows} />}
        </div>
    )
}

// ── Listings tab ───────────────────────────────────────────────────
function ListingsView() {
    const [searchInput, setSearchInput] = useState('')
    const [search, setSearch] = useState('')
    const [company, setCompany] = useState('')
    const [location, setLocation] = useState('')
    const [locationType, setLocationType] = useState('')
    const [source, setSource] = useState('')
    const [seniority, setSeniority] = useState('')
    const [postedWithin, setPostedWithin] = useState('')
    const [sort, setSort] = useState('newest')
    const [page, setPage] = useState(1)

    useEffect(() => {
        const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1) }, 300)
        return () => clearTimeout(t)
    }, [searchInput])
    useEffect(() => { setPage(1) }, [company, location, locationType, source, seniority, postedWithin, sort])

    const { data, isLoading, isFetching, error, refetch } =
        useJobs({ search, company, location, locationType, source, seniority, postedWithin, sort, page })

    const sourceOptions = useMemo(
        () => [{ value: '', label: 'All sources' }, ...(data.facets?.sources || []).map((s) => ({ value: s, label: s }))],
        [data.facets],
    )
    const anyFilter = search || company || location || locationType || source || seniority || postedWithin

    return (
        <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                <input className="input-field" placeholder="Search title, company…" value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)} style={{ flex: '1 1 200px', minWidth: 0 }} />
                <input className="input-field" placeholder="Company" value={company}
                    onChange={(e) => setCompany(e.target.value)} style={{ flex: '0 1 140px', minWidth: 0 }} />
                <input className="input-field" placeholder="Location" value={location}
                    onChange={(e) => setLocation(e.target.value)} style={{ flex: '0 1 140px', minWidth: 0 }} />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 16 }}>
                <Segmented value={locationType} onChange={setLocationType} options={[
                    { value: '', label: 'Any' }, { value: 'remote', label: 'Remote' },
                    { value: 'hybrid', label: 'Hybrid' }, { value: 'onsite', label: 'Onsite' },
                ]} />
                <select className="input-field" value={seniority} onChange={(e) => setSeniority(e.target.value)} style={selStyle}>
                    <option value="">Any level</option>
                    {['intern', 'junior', 'mid', 'senior', 'staff', 'principal'].map((s) => (
                        <option key={s} value={s}>{SEN_LABEL[s]}</option>
                    ))}
                </select>
                <select className="input-field" value={postedWithin} onChange={(e) => setPostedWithin(e.target.value)} style={selStyle}>
                    <option value="">Any time</option>
                    <option value="1">Past 24 hours</option>
                    <option value="3">Past 3 days</option>
                    <option value="5">Past 5 days</option>
                    <option value="older">Older than 5 days</option>
                </select>
                {sourceOptions.length > 1 && (
                    <select className="input-field" value={source} onChange={(e) => setSource(e.target.value)} style={selStyle}>
                        {sourceOptions.map((o) => <option key={o.value || 'all'} value={o.value}>{o.label}</option>)}
                    </select>
                )}
                <select className="input-field" value={sort} onChange={(e) => setSort(e.target.value)} style={selStyle}>
                    <option value="newest">Newest first</option>
                    <option value="oldest">Oldest first</option>
                    <option value="company">By company</option>
                </select>
            </div>

            {isLoading ? (
                <LoadingState label="Loading jobs…" />
            ) : error ? (
                <ErrorState err={error} onRetry={refetch} />
            ) : data.items.length === 0 ? (
                <EmptyState
                    icon="🗂️"
                    title={data.notReady ? 'Jobs feed not live yet' : 'No matching jobs'}
                    message={data.notReady
                        ? 'The crawler hasn’t run its first pass yet.'
                        : (anyFilter ? 'Try loosening the filters.' : 'No open postings right now.')}
                />
            ) : (
                <>
                    <div style={{ fontSize: '0.72rem', color: '#71717a', marginBottom: 10, fontWeight: 700 }}>
                        {data.total.toLocaleString()} job{data.total === 1 ? '' : 's'}
                        {isFetching && <span style={{ color: '#52525b', fontWeight: 400 }}> · updating…</span>}
                    </div>
                    <div style={{ display: 'grid', gap: 9, opacity: isFetching ? 0.6 : 1, transition: 'opacity .15s' }}>
                        {data.items.map((j) => <JobCard key={j.id} j={j} />)}
                    </div>
                    {data.pageCount > 1 && (
                        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 20 }}>
                            <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} style={pagerBtn(page <= 1)}>← Prev</button>
                            <span style={{ fontSize: '0.74rem', color: '#71717a', fontWeight: 700 }}>{data.page} / {data.pageCount}</span>
                            <button type="button" onClick={() => setPage((p) => Math.min(data.pageCount, p + 1))} disabled={page >= data.pageCount} style={pagerBtn(page >= data.pageCount)}>Next →</button>
                        </div>
                    )}
                </>
            )}
        </>
    )
}

function pagerBtn(disabled) {
    return {
        padding: '6px 14px', borderRadius: 6, border: '1px solid #27272a',
        background: 'none', color: disabled ? '#3f3f46' : '#a1a1aa',
        cursor: disabled ? 'default' : 'pointer', fontSize: '0.74rem', fontWeight: 700,
    }
}

// ── page ───────────────────────────────────────────────────────────
const TABS = [['listings', 'Listings'], ['analytics', 'Analytics']]

export default function JobsPage() {
    const [tab, setTab] = useState('listings')
    return (
        <>
            <Navbar />
            <main className="wrap" style={{ maxWidth: 980, margin: '0 auto', padding: '72px 16px 48px' }}>
                <header style={{ marginBottom: 16 }}>
                    <h1 style={{ fontSize: '1.4rem', fontWeight: 900, color: '#fafafa', letterSpacing: '-0.03em' }}>Jobs</h1>
                    <p style={{ color: '#71717a', fontSize: '0.85rem', marginTop: 6 }}>
                        Tech openings crawled from ~500 companies, refreshed through the day. Stale posts drop off after 5 days.
                    </p>
                </header>

                <div className="profile-segment" role="tablist" aria-label="Jobs views" style={{ maxWidth: 320, marginBottom: 18 }}>
                    {TABS.map(([id, label]) => (
                        <button key={id} type="button" role="tab" aria-selected={tab === id}
                            className={'profile-segment-btn' + (tab === id ? ' is-active' : '')}
                            onClick={() => setTab(id)}>
                            {label}
                        </button>
                    ))}
                </div>

                {tab === 'listings' ? <ListingsView /> : <AnalyticsView />}
            </main>
        </>
    )
}

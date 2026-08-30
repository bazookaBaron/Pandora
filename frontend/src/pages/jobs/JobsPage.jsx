import { useEffect, useMemo, useState } from 'react'
import Navbar from '../../components/Navbar'
import { useJobs } from '../../lib/useJobs'
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

const LOC_TONE = { remote: '#4ade80', hybrid: '#22d3ee', onsite: '#f472b6', on_site: '#f472b6' }

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
    const locTone = LOC_TONE[(j.locationType || '').toLowerCase()] || '#a1a1aa'
    return (
        <div style={{
            background: '#161618', border: '1px solid #27272a', borderRadius: 10,
            padding: '11px 14px', display: 'flex', flexDirection: 'column', gap: 7,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 900, fontSize: '0.88rem', color: '#fafafa', letterSpacing: '-0.01em' }}>
                    {j.title || 'Untitled role'}
                </span>
                {j.company && <Chip tone="#38bdf8">{j.company}</Chip>}
                {j.location && <Chip tone="#a1a1aa">{j.location}</Chip>}
                {j.locationType && <Chip tone={locTone}>{j.locationType}</Chip>}
                {j.source && <Chip tone="#a78bfa" label="via">{j.source}</Chip>}
                {fresh && (
                    <span style={{
                        color: '#fbbf24', background: 'rgba(251,191,36,0.14)', border: '1px solid rgba(251,191,36,0.4)',
                        padding: '1px 7px', borderRadius: 999, fontSize: '0.58rem', fontWeight: 900,
                        textTransform: 'uppercase', letterSpacing: '0.07em',
                    }}>new</span>
                )}
                <span style={{ flex: 1 }} />
                <a
                    href={j.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                        padding: '5px 13px', borderRadius: 6, border: '1px solid rgba(34,211,238,0.4)',
                        color: '#22d3ee', fontSize: '0.74rem', fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap',
                    }}
                >
                    Apply →
                </a>
            </div>
            <span style={{ fontSize: '0.66rem', color: '#52525b' }}>
                {j.firstSeen ? `First seen ${relTime(j.firstSeen)}` : ''}
                {j.lastSeen ? `${j.firstSeen ? ' · ' : ''}still live ${relTime(j.lastSeen)}` : ''}
            </span>
        </div>
    )
}

// ── segmented control ──────────────────────────────────────────────
function Segmented({ value, onChange, options }) {
    return (
        <div style={{ display: 'inline-flex', background: '#161618', border: '1px solid #27272a', borderRadius: 8, padding: 3, gap: 2 }}>
            {options.map((o) => {
                const active = value === o.value
                return (
                    <button
                        key={o.value || 'all'}
                        type="button"
                        onClick={() => onChange(o.value)}
                        style={{
                            padding: '4px 11px', borderRadius: 6, border: 'none', cursor: 'pointer',
                            fontSize: '0.72rem', fontWeight: 700,
                            background: active ? '#27272a' : 'transparent',
                            color: active ? '#fafafa' : '#71717a',
                        }}
                    >
                        {o.label}
                    </button>
                )
            })}
        </div>
    )
}

// ── page ───────────────────────────────────────────────────────────
export default function JobsPage() {
    const [searchInput, setSearchInput] = useState('')
    const [search, setSearch] = useState('')
    const [company, setCompany] = useState('')
    const [locationType, setLocationType] = useState('')
    const [source, setSource] = useState('')
    const [page, setPage] = useState(1)

    // debounce the free-text search
    useEffect(() => {
        const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1) }, 300)
        return () => clearTimeout(t)
    }, [searchInput])

    useEffect(() => { setPage(1) }, [company, locationType, source])

    const { data, isLoading, isFetching, error, refetch } = useJobs({ search, company, locationType, source, page })

    const sourceOptions = useMemo(
        () => [{ value: '', label: 'All sources' }, ...(data.facets?.sources || []).map((s) => ({ value: s, label: s }))],
        [data.facets],
    )

    return (
        <>
            <Navbar />
            <main className="wrap" style={{ maxWidth: 980, margin: '0 auto', padding: '72px 16px 48px' }}>
                <header style={{ marginBottom: 18 }}>
                    <h1 style={{ fontSize: '1.4rem', fontWeight: 900, color: '#fafafa', letterSpacing: '-0.03em' }}>Jobs</h1>
                    <p style={{ color: '#71717a', fontSize: '0.85rem', marginTop: 6 }}>
                        Fresh openings crawled from ~500 companies, refreshed through the day. Stale posts drop off after 5 days.
                    </p>
                </header>

                {/* filters */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 16 }}>
                    <input
                        className="input-field"
                        placeholder="Search title, company…"
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        style={{ flex: '1 1 220px', minWidth: 0 }}
                    />
                    <input
                        className="input-field"
                        placeholder="Company"
                        value={company}
                        onChange={(e) => setCompany(e.target.value)}
                        style={{ flex: '0 1 160px', minWidth: 0 }}
                    />
                    <Segmented
                        value={locationType}
                        onChange={setLocationType}
                        options={[
                            { value: '', label: 'Any' },
                            { value: 'remote', label: 'Remote' },
                            { value: 'hybrid', label: 'Hybrid' },
                            { value: 'onsite', label: 'Onsite' },
                        ]}
                    />
                    {sourceOptions.length > 1 && (
                        <select
                            className="input-field"
                            value={source}
                            onChange={(e) => setSource(e.target.value)}
                            style={{ flex: '0 1 150px', minWidth: 0 }}
                        >
                            {sourceOptions.map((o) => <option key={o.value || 'all'} value={o.value}>{o.label}</option>)}
                        </select>
                    )}
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
                            ? 'The crawler hasn’t run its first pass yet. Once it does, postings show up here.'
                            : (search || company || locationType || source
                                ? 'Try loosening the filters.'
                                : 'No open postings right now.')}
                    />
                ) : (
                    <>
                        <div style={{ fontSize: '0.72rem', color: '#71717a', marginBottom: 10, fontWeight: 700 }}>
                            {data.total.toLocaleString()} job{data.total === 1 ? '' : 's'}
                            {isFetching && <span style={{ color: '#52525b', fontWeight: 400 }}> · updating…</span>}
                        </div>
                        <div style={{ display: 'grid', gap: 10, opacity: isFetching ? 0.6 : 1, transition: 'opacity 0.15s' }}>
                            {data.items.map((j) => <JobCard key={j.id} j={j} />)}
                        </div>

                        {data.pageCount > 1 && (
                            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 20 }}>
                                <button
                                    type="button"
                                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                                    disabled={page <= 1}
                                    style={pagerBtn(page <= 1)}
                                >← Prev</button>
                                <span style={{ fontSize: '0.74rem', color: '#71717a', fontWeight: 700 }}>
                                    {data.page} / {data.pageCount}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => setPage((p) => Math.min(data.pageCount, p + 1))}
                                    disabled={page >= data.pageCount}
                                    style={pagerBtn(page >= data.pageCount)}
                                >Next →</button>
                            </div>
                        )}
                    </>
                )}
            </main>
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

import { useState, useEffect, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useProgress } from '../../lib/useProgress'
import { useAuth } from '../../contexts/AuthContext'
import { apiFetch } from '../../lib/apiClient'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { LockedSlice } from '../../components/shared/PaywallGate'
import { ErrorState, EmptyState } from '../../components/shared/states'
import Navbar from '../../components/Navbar'
import FluidCheckbox from '../../components/shared/FluidCheckbox'
import CompanySelector from '../../components/shared/CompanySelector'
import CompanyLogo from '../../components/shared/CompanyLogo'
import Pagination from '../../components/shared/Pagination'

const PAGE_SIZE = 6

function LLDSkeleton() {
    return Array.from({ length: PAGE_SIZE }).map((_, i) => (
        <div key={i} style={{
            background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 8, padding: 16, height: 120,
            animation: 'pulse 1.5s ease-in-out infinite',
        }} />
    ))
}

export default function LLDListPage() {
    const [searchParams, setSearchParams] = useSearchParams()
    const { user } = useAuth()
    const search = searchParams.get('q') || ''
    const [searchInput, setSearchInput] = useState(search)
    const [page, setPage] = useState(1)
    const companies = searchParams.get('company') ? searchParams.get('company').split(',') : []
    const companyKey = companies.join(',')
    const isMobile = useMediaQuery('(max-width: 767px)')

    // Debounce the search box → URL param (300ms) so it feeds the query key
    // without a request per keystroke.
    const searchDebounce = useRef(null)
    const updateSearch = (v) => {
        setSearchInput(v)
        clearTimeout(searchDebounce.current)
        searchDebounce.current = setTimeout(() => {
            setSearchParams(p => { const n = new URLSearchParams(p); n.set('q', v); if (!v) n.delete('q'); return n }, { replace: true })
        }, 300)
    }

    const updateParam = (key, value) => {
        setSearchParams(p => {
            const n = new URLSearchParams(p)
            if (!value || (Array.isArray(value) && !value.length)) n.delete(key)
            else n.set(key, Array.isArray(value) ? value.join(',') : value)
            return n
        }, { replace: true })
        setPage(1)
    }

    // ── Authenticated catalog query ───────────────────────────────────
    // Free tier is capped at `lld_catalog_visible` rows server-side (BEFORE the
    // search/company filter), `pageCount` is 1, `locked = total - cap`. Pro/max
    // get the full filtered set, 12/page. No locked row reaches the browser.
    const qs = new URLSearchParams()
    if (search) qs.set('search', search)
    if (companyKey) qs.set('company', companyKey)
    qs.set('page', String(page))

    const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
        queryKey: ['catalog-lld', { search, company: companyKey, page }],
        queryFn: () => apiFetch('/api/catalog/lld?' + qs.toString()),
        placeholderData: keepPreviousData,
        staleTime: 60 * 1000,
    })

    const items = data?.items || []
    const total = data?.total ?? 0
    const locked = data?.locked ?? 0
    const pageCount = data?.pageCount ?? 1
    const filteredCount = data?.filteredCount ?? items.length
    const unlimited = data?.limit === 'unlimited'

    const { progressMap, toggleStatus } = useProgress('lld')
    const solved = Object.values(progressMap).filter(r => r.status === 'solved').length

    useEffect(() => { setPage(1) }, [search, companyKey])

    const gridCols = isMobile ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))'

    const renderCard = (p) => {
        const prog = progressMap[p.id]
        const isSolved = prog?.status === 'solved'
        return (
            <div key={p.id} style={{
                background: 'var(--panel)', border: `1px solid ${isSolved ? 'rgba(244,114,182,0.3)' : 'var(--subtle)'}`,
                borderRadius: 8, padding: '14px 16px', position: 'relative',
                transition: 'border-color 0.15s, transform 0.15s',
                display: 'flex', flexDirection: 'column', gap: 10,
            }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = isSolved ? 'rgba(244,114,182,0.5)' : 'var(--subtle-strong)' }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.borderColor = isSolved ? 'rgba(244,114,182,0.3)' : 'var(--subtle)' }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <FluidCheckbox
                        checked={isSolved}
                        onChange={() => toggleStatus(p.id, prog?.status ?? 'unsolved')}
                    />
                    {isSolved && (
                        <span style={{ fontSize: '0.6rem', fontWeight: 900, textTransform: 'uppercase', color: '#f472b6', letterSpacing: '0.08em', marginLeft: 'auto' }}>
                            ✓ Practiced
                        </span>
                    )}
                </div>

                <Link to={`/lld/${p.slug}`} style={{ textDecoration: 'none' }}>
                    <h3 style={{
                        fontSize: '0.92rem', fontWeight: 900, color: isSolved ? 'var(--muted)' : 'var(--bright)',
                        letterSpacing: '-0.02em', lineHeight: 1.3, textDecoration: isSolved ? 'line-through' : 'none',
                    }}>
                        {p.title}
                    </h3>
                </Link>

                {p.requirements && (
                    <p style={{
                        fontSize: '0.73rem', color: 'var(--muted)', lineHeight: 1.5,
                        overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    }}>
                        {p.requirements.replace(/[#*`]/g, '').slice(0, 120)}…
                    </p>
                )}

                {(p.companies || []).length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {(p.companies || []).slice(0, 3).map(c => (
                            <CompanyLogo key={c} company={c} />
                        ))}
                        {(p.companies || []).length > 3 && (
                            <span style={{ fontSize: '0.62rem', color: 'var(--faint)', alignSelf: 'center' }}>+{p.companies.length - 3}</span>
                        )}
                    </div>
                )}

                <Link to={`/lld/${p.slug}`} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 4,
                    fontSize: '0.72rem', fontWeight: 900, color: '#f472b6', textDecoration: 'none',
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                }}>
                    Open IDE →
                </Link>
            </div>
        )
    }

    return (
        <>
            <Navbar />
            <div className="has-tilebar" style={{ paddingTop: 56, minHeight: '100vh', maxWidth: 1100, margin: '0 auto', padding: '80px 16px 40px' }}>
                {/* Header */}
                <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', justifyContent: 'space-between', alignItems: isMobile ? 'stretch' : 'flex-end', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
                    <div>
                        <h1 style={{ fontSize: '1.2rem', fontWeight: 900, letterSpacing: '-0.03em', color: 'var(--bright)' }}>LLD Problems</h1>
                        <p style={{ color: 'var(--muted)', fontSize: '0.78rem', marginTop: 2 }}>Low-level design — class diagrams + code walkthroughs</p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 8, padding: '6px 12px' }}>
                        <span style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Practiced</span>
                        <span style={{ fontSize: '0.9rem', fontWeight: 900, color: '#f472b6' }}>{solved}</span>
                        <span style={{ color: 'var(--subtle-strong)' }}>/</span>
                        <span style={{ fontSize: '0.82rem', color: 'var(--accent)' }}>{total}</span>
                    </div>
                </div>

                {/* Filters */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20, alignItems: 'center' }}>
                    <div style={{ position: 'relative', flex: '1 1 220px' }}>
                        <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2">
                            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                        </svg>
                        <input
                            value={searchInput}
                            onChange={e => updateSearch(e.target.value)}
                            placeholder="Search by title or requirements…"
                            style={{
                                width: '100%', padding: '8px 10px 8px 32px', background: 'var(--panel)', border: '1px solid var(--subtle)',
                                borderRadius: 6, color: 'var(--bright)', font: 'inherit', fontSize: '0.82rem', outline: 'none',
                            }}
                            onFocus={e => e.target.style.borderColor = '#f472b6'}
                            onBlur={e => e.target.style.borderColor = 'var(--subtle)'}
                        />
                    </div>
                    <CompanySelector selected={companies} onChange={v => updateParam('company', v)} />
                </div>

                {/* Card Grid */}
                {isLoading ? (
                    <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 12 }}>
                        <LLDSkeleton />
                    </div>
                ) : isError ? (
                    <ErrorState
                        title="Could not load LLD problems."
                        err={error}
                        onRetry={() => refetch()}
                    />
                ) : items.length === 0 ? (
                    <EmptyState
                        icon="🧩"
                        title="No LLD problems match your filters."
                        action={(
                            <button onClick={() => { setSearchInput(''); setSearchParams({}); setPage(1) }} style={{ padding: '6px 16px', background: 'none', border: '1px solid var(--subtle)', borderRadius: 6, color: '#f472b6', cursor: 'pointer', fontSize: '0.78rem' }}>
                                Clear filters
                            </button>
                        )}
                    />
                ) : (
                    <>
                        <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 12, opacity: isFetching ? 0.6 : 1, transition: 'opacity 0.15s' }}>
                            {items.map(renderCard)}
                        </div>

                        {locked > 0 && (
                            <LockedSlice count={locked} noun="LLD problems" variant="card" />
                        )}

                        {pageCount > 1 && (
                            <Pagination page={data?.page ?? page} totalPages={pageCount} onChange={p => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }) }} />
                        )}

                        <div style={{ textAlign: 'center', marginTop: 12, color: 'var(--faint)', fontSize: '0.72rem' }}>
                            {unlimited
                                ? `Showing ${items.length} of ${filteredCount}${pageCount > 1 ? ` · page ${data?.page ?? page} of ${pageCount}` : ''} · ${total} total`
                                : `Preview: ${items.length} of ${total} — upgrade for all`}
                        </div>
                    </>
                )}
            </div>
        </>
    )
}

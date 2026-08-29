import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { useProgress } from '../../lib/useProgress'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { useTier } from '../../lib/useTier'
import { LockedSlice } from '../../components/shared/PaywallGate'
import Navbar from '../../components/Navbar'
import FluidCheckbox from '../../components/shared/FluidCheckbox'
import CompanySelector from '../../components/shared/CompanySelector'
import CompanyLogo from '../../components/shared/CompanyLogo'

const PAGE_SIZE = 6

function LLDSkeleton() {
    return Array.from({ length: PAGE_SIZE }).map((_, i) => (
        <div key={i} style={{
            background: '#18181b', border: '1px solid #27272a', borderRadius: 8, padding: 16, height: 120,
            animation: 'pulse 1.5s ease-in-out infinite',
        }} />
    ))
}

function Pagination({ page, totalPages, onChange }) {
    if (totalPages <= 1) return null
    const pages = []
    for (let i = 1; i <= totalPages; i++) {
        // Show first, last, current ±1
        if (i === 1 || i === totalPages || (i >= page - 1 && i <= page + 1)) {
            pages.push(i)
        } else if (pages[pages.length - 1] !== '…') {
            pages.push('…')
        }
    }
    return (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'center', marginTop: 24 }}>
            <button
                onClick={() => onChange(page - 1)}
                disabled={page === 1}
                style={{
                    padding: '5px 12px', borderRadius: 6, border: '1px solid #27272a',
                    background: 'none', color: page === 1 ? '#3f3f46' : '#a1a1aa', cursor: page === 1 ? 'default' : 'pointer',
                    fontSize: '0.78rem',
                }}
            >← Prev</button>
            {pages.map((p, idx) => (
                p === '…' ? (
                    <span key={`e${idx}`} style={{ color: '#52525b', fontSize: '0.78rem', padding: '0 4px' }}>…</span>
                ) : (
                    <button
                        key={p}
                        onClick={() => onChange(p)}
                        style={{
                            width: 32, height: 32, borderRadius: 6, border: `1px solid ${p === page ? '#f472b6' : '#27272a'}`,
                            background: p === page ? 'rgba(244,114,182,0.12)' : 'none',
                            color: p === page ? '#f472b6' : '#71717a', cursor: 'pointer', fontSize: '0.78rem', fontWeight: p === page ? 900 : 400,
                        }}
                    >{p}</button>
                )
            ))}
            <button
                onClick={() => onChange(page + 1)}
                disabled={page === totalPages}
                style={{
                    padding: '5px 12px', borderRadius: 6, border: '1px solid #27272a',
                    background: 'none', color: page === totalPages ? '#3f3f46' : '#a1a1aa', cursor: page === totalPages ? 'default' : 'pointer',
                    fontSize: '0.78rem',
                }}
            >Next →</button>
        </div>
    )
}

export default function LLDListPage() {
    const [searchParams, setSearchParams] = useSearchParams()
    const [search, setSearch] = useState(searchParams.get('q') || '')
    const [page, setPage] = useState(1)
    const companies = searchParams.get('company') ? searchParams.get('company').split(',') : []
    const isMobile = useMediaQuery('(max-width: 767px)')
    const { isFree, limits } = useTier()

    // ── Free-tier paywall: TRUE server-side limiting ───────────────────
    // On free tier the query fetches ONLY `limits.lld` rows — locked problems
    // (titles, slugs, companies, ids) never enter the browser, the network
    // response, or the React Query cache. Pro tier is unchanged: fetch all,
    // filter + paginate client-side.
    const { data: problems = [], isLoading } = useQuery({
        queryKey: ['lld-problems', isFree ? 'free' : 'pro'],
        queryFn: async () => {
            let q = supabase
                .from('lld_problems')
                .select('id, slug, title, requirements, companies, created_at')
                .order('created_at', { ascending: false })
            if (isFree) q = q.limit(limits.lld)
            const { data, error } = await q
            if (error) throw error
            return data || []
        },
        staleTime: 5 * 60 * 1000,
    })

    // Lightweight count for the "N of TOTAL" copy — head request, no rows.
    // Only fires on free tier (pro already has the full list).
    const { data: total = 0 } = useQuery({
        queryKey: ['lld-count'],
        queryFn: async () => {
            const { count, error } = await supabase
                .from('lld_problems')
                .select('*', { count: 'exact', head: true })
            if (error) throw error
            return count || 0
        },
        staleTime: 5 * 60 * 1000,
        enabled: isFree,
    })

    const { progressMap, toggleStatus } = useProgress('lld')

    const updateParam = (key, value) => {
        setSearchParams(p => {
            const n = new URLSearchParams(p)
            if (!value || (Array.isArray(value) && !value.length)) n.delete(key)
            else n.set(key, Array.isArray(value) ? value.join(',') : value)
            return n
        }, { replace: true })
        setPage(1)
    }

    const filtered = problems.filter(p => {
        if (search && !p.title?.toLowerCase().includes(search.toLowerCase()) && !p.requirements?.toLowerCase().includes(search.toLowerCase())) return false
        if (companies.length && !companies.some(c => (p.companies || []).includes(c))) return false
        return true
    })

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
    const safePage = Math.min(page, totalPages)
    const pagedItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
    const solved = Object.values(progressMap).filter(r => r.status === 'solved').length

    // ── Free-tier paywall ──────────────────────────────────────────
    // `problems` is already capped at `limits.lld` by the query on free tier,
    // so only allowed rows can ever render. The locked remainder is represented
    // by a generic placeholder <LockedSlice> (no real data). `total` (count
    // query) drives the "N of TOTAL" copy. Pagination is hidden for free users.
    const previewLimit = limits.lld
    const isPreview = isFree && total > previewLimit
    const gridCols = isMobile ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))'
    const mainItems = isFree ? filtered.slice(0, previewLimit) : pagedItems

    const renderCard = (p) => {
        const prog = progressMap[p.id]
        const isSolved = prog?.status === 'solved'
        return (
            <div key={p.id} style={{
                background: '#18181b', border: `1px solid ${isSolved ? 'rgba(244,114,182,0.3)' : '#27272a'}`,
                borderRadius: 8, padding: '14px 16px', position: 'relative',
                transition: 'border-color 0.15s, transform 0.15s',
                display: 'flex', flexDirection: 'column', gap: 10,
            }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = isSolved ? 'rgba(244,114,182,0.5)' : '#3f3f46' }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.borderColor = isSolved ? 'rgba(244,114,182,0.3)' : '#27272a' }}
            >
                {/* Top row: checkbox + practiced badge */}
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

                {/* Title */}
                <Link to={`/lld/${p.slug}`} style={{ textDecoration: 'none' }}>
                    <h3 style={{
                        fontSize: '0.92rem', fontWeight: 900, color: isSolved ? '#71717a' : '#fafafa',
                        letterSpacing: '-0.02em', lineHeight: 1.3, textDecoration: isSolved ? 'line-through' : 'none',
                    }}>
                        {p.title}
                    </h3>
                </Link>

                {/* Requirements preview */}
                {p.requirements && (
                    <p style={{
                        fontSize: '0.73rem', color: '#71717a', lineHeight: 1.5,
                        overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    }}>
                        {p.requirements.replace(/[#*`]/g, '').slice(0, 120)}…
                    </p>
                )}

                {/* Company tags */}
                {(p.companies || []).length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {(p.companies || []).slice(0, 3).map(c => (
                            <CompanyLogo key={c} company={c} />
                        ))}
                        {(p.companies || []).length > 3 && (
                            <span style={{ fontSize: '0.62rem', color: '#52525b', alignSelf: 'center' }}>+{p.companies.length - 3}</span>
                        )}
                    </div>
                )}

                {/* Open button */}
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
            <div style={{ paddingTop: 56, minHeight: '100vh', maxWidth: 1100, margin: '0 auto', padding: '80px 16px 40px' }}>
                {/* Header */}
                <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', justifyContent: 'space-between', alignItems: isMobile ? 'stretch' : 'flex-end', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
                    <div>
                        <h1 style={{ fontSize: '1.2rem', fontWeight: 900, letterSpacing: '-0.03em', color: '#fafafa' }}>LLD Problems</h1>
                        <p style={{ color: '#71717a', fontSize: '0.78rem', marginTop: 2 }}>Low-level design — class diagrams + code walkthroughs</p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#18181b', border: '1px solid #27272a', borderRadius: 8, padding: '6px 12px' }}>
                        <span style={{ fontSize: '0.72rem', color: '#71717a', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Practiced</span>
                        <span style={{ fontSize: '0.9rem', fontWeight: 900, color: '#f472b6' }}>{solved}</span>
                        <span style={{ color: '#3f3f46' }}>/</span>
                        <span style={{ fontSize: '0.82rem', color: '#a1a1aa' }}>{isFree ? total : problems.length}</span>
                    </div>
                </div>

                {/* Filters */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20, alignItems: 'center' }}>
                    <div style={{ position: 'relative', flex: '1 1 220px' }}>
                        <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2">
                            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                        </svg>
                        <input
                            value={search}
                            onChange={e => { setSearch(e.target.value); updateParam('q', e.target.value) }}
                            placeholder="Search by title or requirements…"
                            style={{
                                width: '100%', padding: '8px 10px 8px 32px', background: '#18181b', border: '1px solid #27272a',
                                borderRadius: 6, color: '#fafafa', font: 'inherit', fontSize: '0.82rem', outline: 'none',
                            }}
                            onFocus={e => e.target.style.borderColor = '#f472b6'}
                            onBlur={e => e.target.style.borderColor = '#27272a'}
                        />
                    </div>
                    <CompanySelector selected={companies} onChange={v => updateParam('company', v)} />
                </div>

                {/* Card Grid */}
                {isLoading ? (
                    <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 12 }}>
                        <LLDSkeleton />
                    </div>
                ) : filtered.length === 0 ? (
                    <div style={{ padding: '60px 0', textAlign: 'center' }}>
                        <div style={{ fontSize: '2rem', marginBottom: 12 }}>🧩</div>
                        <p style={{ color: '#71717a' }}>No LLD problems match your filters.</p>
                        <button onClick={() => { setSearch(''); setSearchParams({}); setPage(1) }} style={{ marginTop: 12, padding: '6px 16px', background: 'none', border: '1px solid #27272a', borderRadius: 6, color: '#f472b6', cursor: 'pointer', fontSize: '0.78rem' }}>
                            Clear filters
                        </button>
                    </div>
                ) : (
                    <>
                        <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 12 }}>
                            {mainItems.map(renderCard)}
                        </div>

                        {isFree ? (
                            <>
                                {isPreview && (
                                    <LockedSlice count={total - previewLimit} noun="LLD problems" variant="card" />
                                )}
                                <div style={{ textAlign: 'center', marginTop: 12, color: '#52525b', fontSize: '0.72rem' }}>
                                    Preview: {mainItems.length} of {Math.max(total, mainItems.length)} — upgrade for all
                                </div>
                            </>
                        ) : (
                            <>
                                {/* Pagination */}
                                <Pagination page={safePage} totalPages={totalPages} onChange={p => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }) }} />
                                <div style={{ textAlign: 'center', marginTop: 12, color: '#52525b', fontSize: '0.72rem' }}>
                                    {filtered.length} problems · page {safePage} of {totalPages}
                                </div>
                            </>
                        )}
                    </>
                )}
            </div>
        </>
    )
}

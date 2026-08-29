import { useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { useProgress } from '../../lib/useProgress'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { useTier } from '../../lib/useTier'
import { LockedSlice } from '../../components/shared/PaywallGate'
import Navbar from '../../components/Navbar'
import FluidCheckbox from '../../components/shared/FluidCheckbox'
import DifficultyBadge from '../../components/shared/DifficultyBadge'
import CompanySelector from '../../components/shared/CompanySelector'
import CompanyLogo from '../../components/shared/CompanyLogo'

const PAGE_SIZE = 6

function HLDSkeleton() {
    return Array.from({ length: PAGE_SIZE }).map((_, i) => (
        <div key={i} style={{
            background: '#18181b', border: '1px solid #27272a', borderRadius: 8, padding: 16, height: 140,
            animation: 'pulse 1.5s ease-in-out infinite',
        }} />
    ))
}

function Pagination({ page, totalPages, onChange }) {
    if (totalPages <= 1) return null
    const pages = []
    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= page - 1 && i <= page + 1)) pages.push(i)
        else if (pages[pages.length - 1] !== '…') pages.push('…')
    }
    return (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'center', marginTop: 24 }}>
            <button onClick={() => onChange(page - 1)} disabled={page === 1} style={{
                padding: '5px 12px', borderRadius: 6, border: '1px solid #27272a',
                background: 'none', color: page === 1 ? '#3f3f46' : '#a1a1aa', cursor: page === 1 ? 'default' : 'pointer', fontSize: '0.78rem',
            }}>← Prev</button>
            {pages.map((p, idx) => p === '…'
                ? <span key={`e${idx}`} style={{ color: '#52525b', fontSize: '0.78rem', padding: '0 4px' }}>…</span>
                : <button key={p} onClick={() => onChange(p)} style={{
                    width: 32, height: 32, borderRadius: 6, border: `1px solid ${p === page ? '#a78bfa' : '#27272a'}`,
                    background: p === page ? 'rgba(167,139,250,0.12)' : 'none',
                    color: p === page ? '#a78bfa' : '#71717a', cursor: 'pointer', fontSize: '0.78rem', fontWeight: p === page ? 900 : 400,
                }}>{p}</button>
            )}
            <button onClick={() => onChange(page + 1)} disabled={page === totalPages} style={{
                padding: '5px 12px', borderRadius: 6, border: '1px solid #27272a',
                background: 'none', color: page === totalPages ? '#3f3f46' : '#a1a1aa', cursor: page === totalPages ? 'default' : 'pointer', fontSize: '0.78rem',
            }}>Next →</button>
        </div>
    )
}

export default function HLDListPage() {
    const [searchParams, setSearchParams] = useSearchParams()
    const [search, setSearch] = useState(searchParams.get('q') || '')
    const [page, setPage] = useState(1)
    const isMobile = useMediaQuery('(max-width: 767px)')
    const { isFree, limits } = useTier()
    const companies = searchParams.get('company') ? searchParams.get('company').split(',') : []
    const difficulties = searchParams.get('difficulty') ? searchParams.get('difficulty').split(',') : []

    // ── Free-tier paywall: TRUE server-side limiting ───────────────────
    // On free tier the query fetches ONLY `limits.hld` rows — locked questions
    // (titles, slugs, companies, ids) never enter the browser, the network
    // response, or the React Query cache. Pro tier is unchanged.
    const { data: problems = [], isLoading, error: fetchError } = useQuery({
        queryKey: ['hld-problems', isFree ? 'free' : 'pro'],
        queryFn: async () => {
            let q = supabase
                .from('hld_questions')
                .select('*')
                .order('created_at', { ascending: false })
            if (isFree) q = q.limit(limits.hld)
            const { data, error } = await q
            if (error) throw error
            // Normalize: support both `title`/`question` and `slug`/`questionid` column naming
            return (data || []).map(row => ({
                ...row,
                title: row.title || row.question || '(Untitled)',
                description: row.description || '',
                companies: row.companies || row.company || [],
                slug: row.slug || row.questionid || String(row.id),
                difficulty: row.difficulty || null,
            }))
        },
        staleTime: 5 * 60 * 1000,
    })

    // Lightweight count for the "N of TOTAL" copy — head request, no rows.
    // Only fires on free tier (pro already has the full list).
    const { data: total = 0 } = useQuery({
        queryKey: ['hld-count'],
        queryFn: async () => {
            const { count, error } = await supabase
                .from('hld_questions')
                .select('*', { count: 'exact', head: true })
            if (error) throw error
            return count || 0
        },
        staleTime: 5 * 60 * 1000,
        enabled: isFree,
    })

    const { progressMap, toggleStatus } = useProgress('hld')

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
        if (search && !p.title?.toLowerCase().includes(search.toLowerCase()) && !p.description?.toLowerCase().includes(search.toLowerCase())) return false
        if (difficulties.length && !difficulties.includes(p.difficulty)) return false
        if (companies.length && !companies.some(c => (p.companies || []).includes(c))) return false
        return true
    })

    useEffect(() => { setPage(1) }, [search, difficulties.join(','), companies.join(',')])

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
    const safePage = Math.min(page, totalPages)
    const pagedItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
    const attempted = Object.values(progressMap).filter(r => r.status === 'solved').length

    // ── Free-tier preview ──────────────────────────────────────────
    // `problems` is already capped at `limits.hld` by the query on free tier,
    // so only allowed rows can render. The locked remainder is a generic
    // placeholder <LockedSlice> (no real data); `total` drives the count copy.
    const freeLimit = limits.hld
    const isPreview = isFree && total > freeLimit
    const visibleItems = isFree ? filtered.slice(0, freeLimit) : pagedItems
    const gridCols = isMobile ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))'

    const DIFF_COLORS = { Easy: '#4ade80', Medium: '#facc15', Hard: '#f87171' }

    const renderCard = (p) => {
        const prog = progressMap[p.id]
        const isAttempted = prog?.status === 'solved'
        return (
            <div key={p.id} style={{
                background: '#18181b', border: `1px solid ${isAttempted ? 'rgba(167,139,250,0.3)' : '#27272a'}`,
                borderRadius: 8, padding: '14px 16px', position: 'relative',
                transition: 'border-color 0.15s, transform 0.15s',
                display: 'flex', flexDirection: 'column', gap: 10,
            }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = isAttempted ? 'rgba(167,139,250,0.5)' : '#3f3f46' }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.borderColor = isAttempted ? 'rgba(167,139,250,0.3)' : '#27272a' }}
            >
                {/* Top row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <FluidCheckbox
                        checked={isAttempted}
                        onChange={() => toggleStatus(p.id, prog?.status ?? 'unsolved')}
                    />
                    {p.difficulty && <DifficultyBadge difficulty={p.difficulty} />}
                    {isAttempted && (
                        <span style={{ fontSize: '0.6rem', fontWeight: 900, textTransform: 'uppercase', color: '#a78bfa', letterSpacing: '0.08em', marginLeft: 'auto' }}>
                            ✓ Attempted
                        </span>
                    )}
                </div>

                {/* Title */}
                <Link to={`/hld/${p.slug || p.id}`} style={{ textDecoration: 'none' }}>
                    <h3 style={{
                        fontSize: '0.92rem', fontWeight: 900, color: isAttempted ? '#71717a' : '#fafafa',
                        letterSpacing: '-0.02em', lineHeight: 1.3,
                    }}>
                        {p.title}
                    </h3>
                </Link>

                {/* Description preview */}
                {p.description && (
                    <p style={{
                        fontSize: '0.73rem', color: '#71717a', lineHeight: 1.5,
                        overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    }}>
                        {p.description.replace(/[#*`]/g, '').slice(0, 130)}…
                    </p>
                )}

                {/* Company logos */}
                {(p.companies || []).length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {(p.companies || []).slice(0, 4).map(c => (
                            <CompanyLogo key={c} company={c} />
                        ))}
                        {(p.companies || []).length > 4 && (
                            <span style={{ fontSize: '0.62rem', color: '#52525b', alignSelf: 'center' }}>+{p.companies.length - 4}</span>
                        )}
                    </div>
                )}

                {/* Open button */}
                <Link to={`/hld/${p.slug || p.id}`} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 4,
                    fontSize: '0.72rem', fontWeight: 900, color: '#a78bfa', textDecoration: 'none',
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                }}>
                    Design →
                </Link>
            </div>
        )
    }

    return (
        <>
            <Navbar />
            <div style={{ paddingTop: 56, minHeight: '100vh', maxWidth: 1100, margin: '0 auto', padding: '80px 16px 40px' }}>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
                    <div>
                        <h1 style={{ fontSize: '1.2rem', fontWeight: 900, letterSpacing: '-0.03em', color: '#fafafa' }}>HLD Questions</h1>
                        <p style={{ color: '#71717a', fontSize: '0.78rem', marginTop: 2 }}>High-level system design — architecture, scalability, trade-offs</p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#18181b', border: '1px solid #27272a', borderRadius: 8, padding: '6px 12px' }}>
                        <span style={{ fontSize: '0.72rem', color: '#71717a', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Attempted</span>
                        <span style={{ fontSize: '0.9rem', fontWeight: 900, color: '#a78bfa' }}>{attempted}</span>
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
                            placeholder="Search by title or description…"
                            style={{
                                width: '100%', padding: '8px 10px 8px 32px', background: '#18181b', border: '1px solid #27272a',
                                borderRadius: 6, color: '#fafafa', font: 'inherit', fontSize: '0.82rem', outline: 'none',
                            }}
                            onFocus={e => e.target.style.borderColor = '#a78bfa'}
                            onBlur={e => e.target.style.borderColor = '#27272a'}
                        />
                    </div>

                    {/* Difficulty pills */}
                    <div style={{ display: 'flex', gap: 4 }}>
                        {['Easy', 'Medium', 'Hard'].map(d => {
                            const active = difficulties.includes(d)
                            return (
                                <button key={d} onClick={() => {
                                    const next = active ? difficulties.filter(x => x !== d) : [...difficulties, d]
                                    updateParam('difficulty', next)
                                }} style={{
                                    padding: '5px 10px', borderRadius: 6, border: `1px solid ${active ? DIFF_COLORS[d] : '#27272a'}`,
                                    background: active ? `${DIFF_COLORS[d]}1F` : 'transparent',
                                    color: active ? DIFF_COLORS[d] : '#71717a', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 900,
                                    textTransform: 'uppercase', letterSpacing: '0.06em',
                                }}>{d}</button>
                            )
                        })}
                    </div>

                    <CompanySelector selected={companies} onChange={v => updateParam('company', v)} />
                </div>

                {/* Card Grid */}
                {isLoading ? (
                    <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 12 }}>
                        <HLDSkeleton />
                    </div>
                ) : fetchError ? (
                    <div style={{ padding: '60px 0', textAlign: 'center' }}>
                        <div style={{ fontSize: '2rem', marginBottom: 12 }}>⚠️</div>
                        <p style={{ color: '#f87171', fontSize: '0.85rem', marginBottom: 8 }}>Could not load HLD questions.</p>
                        <p style={{ color: '#52525b', fontSize: '0.75rem', fontFamily: 'monospace' }}>{fetchError.message}</p>
                    </div>
                ) : filtered.length === 0 ? (
                    <div style={{ padding: '60px 0', textAlign: 'center' }}>
                        <div style={{ fontSize: '2rem', marginBottom: 12 }}>🏗️</div>
                        <p style={{ color: '#71717a' }}>No HLD questions match your filters.</p>
                        <button onClick={() => { setSearch(''); setSearchParams({}); setPage(1) }} style={{ marginTop: 12, padding: '6px 16px', background: 'none', border: '1px solid #27272a', borderRadius: 6, color: '#a78bfa', cursor: 'pointer', fontSize: '0.78rem' }}>
                            Clear filters
                        </button>
                    </div>
                ) : (
                    <>
                        <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 12 }}>
                            {visibleItems.map(renderCard)}
                        </div>

                        {isPreview && (
                            <LockedSlice count={total - freeLimit} noun="HLD questions" variant="card" />
                        )}

                        {!isFree && (
                            <Pagination page={safePage} totalPages={totalPages} onChange={p => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }) }} />
                        )}
                        <div style={{ textAlign: 'center', marginTop: 12, color: '#52525b', fontSize: '0.72rem' }}>
                            {isFree
                                ? (isPreview
                                    ? `Preview: ${visibleItems.length} of ${Math.max(total, visibleItems.length)} — upgrade for all`
                                    : `${Math.max(total, filtered.length)} questions`)
                                : `${filtered.length} questions · page ${safePage} of ${totalPages}`}
                        </div>
                    </>
                )}
            </div>
        </>
    )
}

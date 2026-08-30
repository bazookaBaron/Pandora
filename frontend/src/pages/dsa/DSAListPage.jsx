import { useState, useEffect, useCallback, useRef } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { Lock } from 'lucide-react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useProgress } from '../../lib/useProgress'
import { useAuth } from '../../contexts/AuthContext'
import { apiFetch } from '../../lib/apiClient'
import Navbar from '../../components/Navbar'
import FluidCheckbox from '../../components/shared/FluidCheckbox'
import DifficultyBadge from '../../components/shared/DifficultyBadge'
import CompanySelector from '../../components/shared/CompanySelector'
import CompanyLogo from '../../components/shared/CompanyLogo'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { LockedSlice } from '../../components/shared/PaywallGate'
import { ErrorState, EmptyState } from '../../components/shared/states'
import { track, EVENTS } from '../../lib/analytics'

const DIFFICULTIES = ['Easy', 'Medium', 'Hard']
// Server sorts: 'id' (default table order), 'alpha', 'difficulty'. The old
// client-only 'shuffle' is gone — the server has no equivalent.
const SORT_OPTIONS = [
    { value: 'id', label: 'Default' },
    { value: 'alpha', label: 'A–Z' },
    { value: 'difficulty', label: 'Difficulty' },
]

function Pagination({ page, totalPages, onChange }) {
    if (totalPages <= 1) return null
    const pages = []
    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= page - 1 && i <= page + 1)) pages.push(i)
        else if (pages[pages.length - 1] !== '…') pages.push('…')
    }
    return (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'center', marginTop: 16 }}>
            <button onClick={() => onChange(page - 1)} disabled={page === 1} style={{
                padding: '5px 12px', borderRadius: 6, border: '1px solid var(--subtle)',
                background: 'none', color: page === 1 ? 'var(--subtle-strong)' : 'var(--accent)', cursor: page === 1 ? 'default' : 'pointer', fontSize: '0.78rem',
            }}>← Prev</button>
            {pages.map((p, idx) => p === '…'
                ? <span key={`e${idx}`} style={{ color: 'var(--faint)', fontSize: '0.78rem', padding: '0 4px' }}>…</span>
                : <button key={p} onClick={() => onChange(p)} style={{
                    width: 32, height: 32, borderRadius: 6, border: `1px solid ${p === page ? '#22d3ee' : 'var(--subtle)'}`,
                    background: p === page ? 'rgba(34,211,238,0.12)' : 'none',
                    color: p === page ? '#22d3ee' : 'var(--muted)', cursor: 'pointer', fontSize: '0.78rem', fontWeight: p === page ? 900 : 400,
                }}>{p}</button>
            )}
            <button onClick={() => onChange(page + 1)} disabled={page === totalPages} style={{
                padding: '5px 12px', borderRadius: 6, border: '1px solid var(--subtle)',
                background: 'none', color: page === totalPages ? 'var(--subtle-strong)' : 'var(--accent)', cursor: page === totalPages ? 'default' : 'pointer', fontSize: '0.78rem',
            }}>Next →</button>
        </div>
    )
}

function CompanyBadges({ companies = [], isMobile = false }) {
    const [expanded, setExpanded] = useState(false)
    if (!companies.length) return null

    const limit = isMobile ? 3 : 6
    const overflow = companies.length - limit
    const shown = expanded ? companies : companies.slice(0, limit)

    return (
        <div style={{
            display: 'flex', gap: 3, alignItems: 'center', minWidth: 0,
            flexWrap: expanded ? 'wrap' : 'nowrap',
            overflow: expanded ? 'visible' : 'hidden',
        }}>
            {shown.map(c => (
                <Link key={c} to={`/dsa/company/${encodeURIComponent(c)}`}
                    style={{ textDecoration: 'none', flexShrink: 0 }}
                    onClick={e => e.stopPropagation()}>
                    <CompanyLogo company={c} />
                </Link>
            ))}
            {overflow > 0 && (
                <button
                    onClick={e => { e.stopPropagation(); setExpanded(v => !v) }}
                    title={expanded ? 'Show fewer' : `Show ${overflow} more`}
                    style={{
                        flexShrink: 0, padding: '2px 8px', borderRadius: 4,
                        border: '1px solid var(--subtle-strong)', background: 'var(--panel)',
                        color: '#22d3ee', cursor: 'pointer', fontSize: '0.62rem',
                        fontWeight: 900, lineHeight: 1.4, whiteSpace: 'nowrap',
                    }}
                >
                    {expanded ? '− less' : `+${overflow}`}
                </button>
            )}
        </div>
    )
}

// Placeholder for a company-matched question hidden behind Premium (task 2).
// No title / tags / metadata — only a lock. Roughly matches ProblemRow size.
function LockedQuestionCard({ isMobile, onClick }) {
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onClick}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
            title="Upgrade to unlock this question"
            style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: isMobile ? '14px 12px' : '13px 12px',
                borderBottom: '1px solid rgba(39,39,42,0.5)',
                color: 'var(--faint)', cursor: 'pointer',
                background: 'repeating-linear-gradient(45deg, transparent, transparent 8px, rgba(255,255,255,0.02) 8px, rgba(255,255,255,0.02) 16px)',
            }}
        >
            <Lock size={15} />
            <span style={{ fontSize: '0.74rem', fontWeight: 700, letterSpacing: '0.02em' }}>Premium question</span>
        </div>
    )
}

function ProblemRow({ p, prog, isMobile, onToggleStatus, onToggleBookmark }) {
    const isSolved = prog?.status === 'solved'
    const isBookmarked = prog?.is_bookmarked

    const handleToggleStatus = () => {
        // Fire completion only on the unsolved → solved transition.
        if (prog?.status !== 'solved') {
            track(EVENTS.QUESTION_COMPLETED, { type: 'dsa', problem_id: p.id, difficulty: p.difficulty })
        }
        onToggleStatus(p.id, prog?.status ?? 'unsolved')
    }

    const titleBlock = (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', minWidth: 0, flex: 1 }}>
            <a href={p.link} target="_blank" rel="noopener noreferrer"
                onClick={() => track(EVENTS.QUESTION_STARTED, { type: 'dsa', problem_id: p.id, difficulty: p.difficulty })}
                style={{
                    color: isSolved ? 'var(--muted)' : 'var(--bright)', textDecoration: 'none',
                    fontSize: '0.85rem', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    textDecorationLine: isSolved ? 'line-through' : 'none',
                }}>
                {p.title}
            </a>
            <button onClick={() => onToggleBookmark(p.id)}
                title="Bookmark"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: isBookmarked ? '#facc15' : 'var(--subtle-strong)', padding: 0, flexShrink: 0 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill={isBookmarked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>
            </button>
        </div>
    )

    if (isMobile) {
        return (
            <div style={{
                padding: '12px', borderBottom: '1px solid rgba(39,39,42,0.5)',
                background: isSolved ? 'rgba(34,211,238,0.03)' : 'transparent',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <FluidCheckbox checked={isSolved} onChange={handleToggleStatus} />
                    {titleBlock}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    <DifficultyBadge difficulty={p.difficulty} />
                    <CompanyBadges companies={p.company || []} isMobile />
                </div>
            </div>
        )
    }

    return (
        <div style={{
            display: 'grid', gridTemplateColumns: '28px 1fr 90px 1fr',
            gap: 8, padding: '10px 12px', alignItems: 'center',
            borderBottom: '1px solid rgba(39,39,42,0.5)',
            background: isSolved ? 'rgba(34,211,238,0.03)' : 'transparent',
            transition: 'background 0.15s',
        }}
            onMouseEnter={e => { if (!isSolved) e.currentTarget.style.background = 'var(--panel)' }}
            onMouseLeave={e => { e.currentTarget.style.background = isSolved ? 'rgba(34,211,238,0.03)' : 'transparent' }}
        >
            <FluidCheckbox checked={isSolved} onChange={handleToggleStatus} />
            {titleBlock}
            <DifficultyBadge difficulty={p.difficulty} />
            <CompanyBadges companies={p.company || []} />
        </div>
    )
}


export default function DSAListPage({ filterCompany }) {
    const [searchParams, setSearchParams] = useSearchParams()
    const { user } = useAuth()
    const navigate = useNavigate()
    const isMobile = useMediaQuery('(max-width: 767px)')

    // Read filters from URL params. `q` is written on a 300ms debounce below, so
    // reading it back here gives us the debounced search term for the query key.
    const search = searchParams.get('q') || ''
    const companies = searchParams.get('company')
        ? searchParams.get('company').split(',')
        : filterCompany ? [filterCompany] : []
    const difficulties = searchParams.get('difficulty') ? searchParams.get('difficulty').split(',') : []
    const sort = searchParams.get('sort') || 'id'
    const statusFilter = searchParams.get('status') || ''
    const [showMoreFilters, setShowMoreFilters] = useState(false)
    const [searchInput, setSearchInput] = useState(search)
    const [page, setPage] = useState(1)

    const companyKey = companies.join(',')
    const difficultyKey = difficulties.join(',')

    // Debounce the search box → URL param (300ms).
    const searchDebounce = useRef(null)
    const updateSearch = (v) => {
        setSearchInput(v)
        clearTimeout(searchDebounce.current)
        searchDebounce.current = setTimeout(() => {
            setSearchParams(p => { const n = new URLSearchParams(p); n.set('q', v); if (!v) n.delete('q'); return n }, { replace: true })
        }, 300)
    }

    const updateParam = useCallback((key, value) => {
        setSearchParams(p => {
            const n = new URLSearchParams(p)
            if (!value || (Array.isArray(value) && !value.length)) n.delete(key)
            else n.set(key, Array.isArray(value) ? value.join(',') : value)
            return n
        }, { replace: true })
        setPage(1)
    }, [setSearchParams])

    // ── Single authenticated catalog query ─────────────────────────────
    // Tier caps are enforced server-side: a free user gets at most
    // `dsa_catalog_visible` rows (applied BEFORE filter/sort/page), `pageCount`
    // is 1, and `locked = total - cap`. Pro/max get the full filtered + sorted
    // set, 50/page. No locked row ever reaches the browser.
    const qs = new URLSearchParams()
    if (search) qs.set('search', search)
    if (companyKey) qs.set('company', companyKey)
    if (difficultyKey) qs.set('difficulty', difficultyKey)
    if (sort) qs.set('sort', sort)
    qs.set('page', String(page))

    const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
        queryKey: ['catalog-dsa', { search, company: companyKey, difficulty: difficultyKey, sort, page }],
        queryFn: () => apiFetch('/api/catalog/dsa?' + qs.toString()),
        enabled: !!user,
        placeholderData: keepPreviousData,
        staleTime: 60 * 1000,
    })

    const items = data?.items || []
    const total = data?.total ?? 0
    const locked = data?.locked ?? 0
    const lockedCount = data?.lockedCount ?? locked
    const companyLock = !!data?.companyLock // free user + company filter → per-question lock cards
    const filteredCount = data?.filteredCount ?? items.length
    const pageCount = data?.pageCount ?? 1
    const unlimited = data?.limit === 'unlimited'

    const { progressMap, toggleStatus, toggleBookmark } = useProgress('dsa')

    // Status-filter chips act only over the rows currently fetched (a page on
    // pro/max, the preview slice on free) — the server has no progress context.
    let viewItems = items
    if (statusFilter === 'solved') viewItems = items.filter(p => progressMap[p.id]?.status === 'solved')
    else if (statusFilter === 'attempted') viewItems = items.filter(p => progressMap[p.id]?.status === 'attempted')
    else if (statusFilter === 'unsolved') viewItems = items.filter(p => !progressMap[p.id] || progressMap[p.id]?.status === 'unsolved')
    else if (statusFilter === 'bookmarked') viewItems = items.filter(p => progressMap[p.id]?.is_bookmarked)

    const solved = Object.values(progressMap).filter(r => r.status === 'solved').length

    // Reset to page 1 when filters change.
    useEffect(() => { setPage(1) }, [search, difficultyKey, companyKey, sort])

    // Keyboard shortcut: `/` focuses search.
    useEffect(() => {
        const handler = (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
            if (e.key === '/') { e.preventDefault(); document.getElementById('dsa-search')?.focus() }
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [])

    const pickRandom = () => {
        const unsolved = viewItems.filter(p => !progressMap[p.id] || progressMap[p.id]?.status !== 'solved')
        if (unsolved.length) {
            const r = unsolved[Math.floor(Math.random() * unsolved.length)]
            window.open(r.link, '_blank', 'noopener')
        }
    }

    return (
        <>
            <Navbar />
            <div style={{ paddingTop: 56, minHeight: '100vh' }}>
                <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 16px' }}>

                    {/* Header + progress */}
                    <div style={{ marginBottom: 20 }}>
                        <div style={{
                            display: 'flex', gap: 8,
                            alignItems: isMobile ? 'stretch' : 'baseline',
                            justifyContent: 'space-between',
                            flexWrap: 'wrap',
                            flexDirection: isMobile ? 'column' : 'row',
                        }}>
                            <div>
                                <h1 style={{ fontSize: '1.2rem', fontWeight: 900, color: 'var(--bright)', letterSpacing: '-0.03em' }}>DSA Problems</h1>
                                <p style={{ color: 'var(--muted)', fontSize: '0.78rem', marginTop: 2 }}>LeetCode company-wise — {total} problems</p>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 8, padding: '6px 12px' }}>
                                    <span style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Solved</span>
                                    <span style={{ fontSize: '0.9rem', fontWeight: 900, color: '#22d3ee' }}>{solved}</span>
                                    <span style={{ color: 'var(--subtle-strong)', fontSize: '0.8rem' }}>/</span>
                                    <span style={{ fontSize: '0.82rem', color: 'var(--accent)' }}>{total}</span>
                                </div>
                                <button onClick={pickRandom} style={{
                                    fontSize: '0.72rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.06em',
                                    padding: '7px 12px', background: 'none', border: '1px solid var(--subtle)', borderRadius: 6,
                                    color: '#f472b6', cursor: 'pointer', whiteSpace: 'nowrap',
                                }}>
                                    🎲 Random
                                </button>
                            </div>
                        </div>

                        {/* Difficulty breakdown — over the rows currently in view */}
                        {items.length > 0 && (
                            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                                {DIFFICULTIES.map(d => {
                                    const dTotal = items.filter(p => p.difficulty === d).length
                                    const done = items.filter(p => p.difficulty === d && progressMap[p.id]?.status === 'solved').length
                                    return (
                                        <div key={d} style={{ fontSize: '0.7rem', color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                                            <DifficultyBadge difficulty={d} />
                                            <span>{done}/{dTotal}</span>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>

                    {/* --- Filter bar --- */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12, alignItems: 'center' }}>
                        <div style={{ position: 'relative', flex: isMobile ? '1 1 100%' : '1 1 220px' }}>
                            <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2">
                                <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                            </svg>
                            <input
                                id="dsa-search"
                                value={searchInput}
                                onChange={e => updateSearch(e.target.value)}
                                placeholder="Search title or topics… ( / )"
                                style={{
                                    width: '100%', padding: '8px 10px 8px 32px', background: 'var(--panel)', border: '1px solid var(--subtle)',
                                    borderRadius: 6, color: 'var(--bright)', font: 'inherit', fontSize: '0.82rem', outline: 'none',
                                }}
                                onFocus={e => e.target.style.borderColor = '#22d3ee'}
                                onBlur={e => e.target.style.borderColor = 'var(--subtle)'}
                            />
                        </div>

                        {/* Difficulty chips */}
                        <div style={{ display: 'flex', gap: 4 }}>
                            {DIFFICULTIES.map(d => {
                                const active = difficulties.includes(d)
                                const colors = { Easy: '#4ade80', Medium: '#facc15', Hard: '#f87171' }
                                return (
                                    <button key={d} onClick={() => {
                                        const next = active ? difficulties.filter(x => x !== d) : [...difficulties, d]
                                        updateParam('difficulty', next)
                                    }} style={{
                                        padding: '5px 10px', borderRadius: 6, border: `1px solid ${active ? colors[d] : 'var(--subtle)'}`,
                                        background: active ? `rgba(${d === 'Easy' ? '74,222,128' : d === 'Medium' ? '250,204,21' : '248,113,113'},0.12)` : 'transparent',
                                        color: active ? colors[d] : 'var(--muted)', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 900,
                                        textTransform: 'uppercase', letterSpacing: '0.06em', transition: 'all 0.15s',
                                    }}>{d}</button>
                                )
                            })}
                        </div>

                        <CompanySelector
                            selected={companies}
                            onChange={v => updateParam('company', v)}
                        />

                        <select
                            value={sort}
                            onChange={e => updateParam('sort', e.target.value)}
                            style={{
                                padding: '6px 10px', background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 6,
                                color: 'var(--accent)', font: 'inherit', fontSize: '0.78rem', outline: 'none', cursor: 'pointer',
                            }}
                        >
                            {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>

                        <button onClick={() => setShowMoreFilters(v => !v)} style={{
                            padding: '6px 12px', background: showMoreFilters ? '#22d3ee' : 'none', border: '1px solid var(--subtle)',
                            borderRadius: 6, color: showMoreFilters ? 'var(--surface)' : 'var(--muted)', cursor: 'pointer', fontSize: '0.72rem',
                            fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.06em',
                        }}>
                            {showMoreFilters ? '▲ Less' : '▼ More'}
                        </button>
                    </div>

                    {/* More filters */}
                    {showMoreFilters && (
                        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 12, padding: '12px 16px', background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 8 }}>
                            <div>
                                <label style={{ fontSize: '0.65rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', display: 'block', marginBottom: 6 }}>Status</label>
                                <div style={{ display: 'flex', gap: 4 }}>
                                    {['', 'solved', 'attempted', 'unsolved', 'bookmarked'].map(s => (
                                        <button key={s} onClick={() => updateParam('status', s)} style={{
                                            padding: '4px 10px', borderRadius: 5, border: `1px solid ${statusFilter === s ? '#22d3ee' : 'var(--subtle)'}`,
                                            background: statusFilter === s ? 'rgba(34,211,238,0.12)' : 'transparent',
                                            color: statusFilter === s ? '#22d3ee' : 'var(--muted)', cursor: 'pointer', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase',
                                        }}>
                                            {s || 'All'}
                                        </button>
                                    ))}
                                </div>
                                <p style={{ fontSize: '0.62rem', color: 'var(--faint)', marginTop: 6 }}>
                                    Status filters apply to the rows on this page only.
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Table header */}
                    {!isMobile && (
                        <div style={{
                            display: 'grid', gridTemplateColumns: '28px 1fr 90px 1fr',
                            gap: 8, padding: '6px 12px', borderBottom: '1px solid var(--subtle)',
                            fontSize: '0.62rem', fontWeight: 900, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '0.08em',
                        }}>
                            <span></span>
                            <span>Problem</span>
                            <span>Difficulty</span>
                            <span>Companies</span>
                        </div>
                    )}

                    {isLoading ? (
                        <div>
                            {Array.from({ length: 12 }).map((_, i) => (
                                <div key={i} style={{ height: 51, borderBottom: '1px solid var(--panel)', display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px' }}>
                                    <div style={{ width: 20, height: 20, borderRadius: 4, background: 'var(--subtle)' }} />
                                    <div style={{ flex: 1, height: 14, borderRadius: 4, background: 'var(--panel)', animation: 'pulse 1.5s ease-in-out infinite' }} />
                                    <div style={{ width: 60, height: 14, borderRadius: 4, background: 'var(--panel)' }} />
                                </div>
                            ))}
                        </div>
                    ) : isError ? (
                        <ErrorState
                            title="Could not load DSA problems."
                            err={error}
                            onRetry={() => refetch()}
                        />
                    ) : viewItems.length === 0 ? (
                        <EmptyState
                            icon="🔍"
                            title="No problems match your filters."
                            action={(
                                <button onClick={() => setSearchParams({})} style={{ padding: '6px 16px', background: 'none', border: '1px solid var(--subtle)', borderRadius: 6, color: '#22d3ee', cursor: 'pointer', fontSize: '0.78rem' }}>
                                    Clear filters
                                </button>
                            )}
                        />
                    ) : (
                        <>
                            <div style={{ opacity: isFetching ? 0.6 : 1, transition: 'opacity 0.15s' }}>
                                {viewItems.map(p => (
                                    <ProblemRow
                                        key={p.id}
                                        p={p}
                                        prog={progressMap[p.id]}
                                        isMobile={isMobile}
                                        onToggleStatus={toggleStatus}
                                        onToggleBookmark={toggleBookmark}
                                    />
                                ))}
                            </div>

                            {companyLock && lockedCount > 0 && (
                                <>
                                    <div style={{
                                        margin: '10px 0', padding: '10px 14px', borderRadius: 8,
                                        border: '1px solid rgba(167,139,250,0.35)', background: 'rgba(167,139,250,0.08)',
                                        fontSize: '0.78rem', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 8,
                                        flexWrap: 'wrap',
                                    }}>
                                        <Lock size={14} style={{ color: '#a78bfa', flexShrink: 0 }} />
                                        <span><strong style={{ color: 'var(--bright)' }}>{lockedCount}</strong> more question{lockedCount === 1 ? '' : 's'} available with Premium</span>
                                        <Link to="/pricing" style={{ color: '#a78bfa', fontWeight: 700, textDecoration: 'none' }}>— Upgrade to unlock</Link>
                                    </div>
                                    <div style={{ opacity: isFetching ? 0.6 : 1 }}>
                                        {/* one placeholder per hidden question; capped so a company
                                            with hundreds of matches doesn't blow up the DOM. */}
                                        {Array.from({ length: Math.min(lockedCount, 100) }).map((_, i) => (
                                            <LockedQuestionCard key={`lock-${i}`} isMobile={isMobile} onClick={() => navigate('/pricing')} />
                                        ))}
                                    </div>
                                </>
                            )}

                            {!companyLock && locked > 0 && (
                                <LockedSlice count={locked} noun="DSA problems" variant="row" />
                            )}

                            {pageCount > 1 && (
                                <Pagination page={data?.page ?? page} totalPages={pageCount} onChange={p => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }) }} />
                            )}
                        </>
                    )}

                    {!isLoading && !isError && (
                        <div style={{ marginTop: 8, color: 'var(--faint)', fontSize: '0.72rem', textAlign: 'center' }}>
                            {unlimited ? (
                                <>
                                    Showing {items.length} of {filteredCount} · {total} total · Press <kbd style={{ border: '1px solid var(--subtle)', borderRadius: 3, padding: '0 4px', fontSize: '0.65rem', color: 'var(--muted)' }}>/</kbd> to search
                                </>
                            ) : (
                                <>
                                    Preview: {items.length} of {total}
                                    {' — '}
                                    <Link to="/pricing" style={{ color: '#22d3ee', textDecoration: 'none', fontWeight: 700 }}>upgrade for all</Link>
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </>
    )
}

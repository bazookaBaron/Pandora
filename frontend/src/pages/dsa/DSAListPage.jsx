import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { useProgress } from '../../lib/useProgress'
import { useAuth } from '../../contexts/AuthContext'
import Navbar from '../../components/Navbar'
import FluidCheckbox from '../../components/shared/FluidCheckbox'
import DifficultyBadge from '../../components/shared/DifficultyBadge'
import CompanySelector from '../../components/shared/CompanySelector'
import CompanyLogo from '../../components/shared/CompanyLogo'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { useTier } from '../../lib/useTier'
import { LockedSlice } from '../../components/shared/PaywallGate'

const DIFFICULTIES = ['Easy', 'Medium', 'Hard']
const SORT_OPTIONS = [
    { value: 'shuffle', label: '🔀 Shuffle' },
    { value: 'difficulty', label: 'Difficulty' },
    { value: 'alpha', label: 'A–Z' },
]

// Seeded pseudo-random number generator (mulberry32) for stable shuffle
function mulberry32(seed) {
    return function () {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
        return ((t ^ t >>> 14) >>> 0) / 4294967296
    }
}
function seededShuffle(arr, seed) {
    const rng = mulberry32(seed)
    const a = [...arr]
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]]
    }
    return a
}
function getOrCreateSeed() {
    const key = 'dsa_shuffle_seed'
    let s = sessionStorage.getItem(key)
    if (!s) { s = String(Date.now() & 0x7fffffff); sessionStorage.setItem(key, s) }
    return parseInt(s, 10)
}

const PAGE_SIZE = 30

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
                padding: '5px 12px', borderRadius: 6, border: '1px solid #27272a',
                background: 'none', color: page === 1 ? '#3f3f46' : '#a1a1aa', cursor: page === 1 ? 'default' : 'pointer', fontSize: '0.78rem',
            }}>← Prev</button>
            {pages.map((p, idx) => p === '…'
                ? <span key={`e${idx}`} style={{ color: '#52525b', fontSize: '0.78rem', padding: '0 4px' }}>…</span>
                : <button key={p} onClick={() => onChange(p)} style={{
                    width: 32, height: 32, borderRadius: 6, border: `1px solid ${p === page ? '#22d3ee' : '#27272a'}`,
                    background: p === page ? 'rgba(34,211,238,0.12)' : 'none',
                    color: p === page ? '#22d3ee' : '#71717a', cursor: 'pointer', fontSize: '0.78rem', fontWeight: p === page ? 900 : 400,
                }}>{p}</button>
            )}
            <button onClick={() => onChange(page + 1)} disabled={page === totalPages} style={{
                padding: '5px 12px', borderRadius: 6, border: '1px solid #27272a',
                background: 'none', color: page === totalPages ? '#3f3f46' : '#a1a1aa', cursor: page === totalPages ? 'default' : 'pointer', fontSize: '0.78rem',
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
                        border: '1px solid #3f3f46', background: '#18181b',
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

function ProblemRow({ p, prog, isMobile, onToggleStatus, onToggleBookmark }) {
    const isSolved = prog?.status === 'solved'
    const isBookmarked = prog?.is_bookmarked

    const titleBlock = (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', minWidth: 0, flex: 1 }}>
            <a href={p.link} target="_blank" rel="noopener noreferrer"
                style={{
                    color: isSolved ? '#71717a' : '#fafafa', textDecoration: 'none',
                    fontSize: '0.85rem', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    textDecorationLine: isSolved ? 'line-through' : 'none',
                }}>
                {p.title}
            </a>
            <button onClick={() => onToggleBookmark(p.id)}
                title="Bookmark"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: isBookmarked ? '#facc15' : '#3f3f46', padding: 0, flexShrink: 0 }}>
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
                    <FluidCheckbox checked={isSolved} onChange={() => onToggleStatus(p.id, prog?.status ?? 'unsolved')} />
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
            onMouseEnter={e => { if (!isSolved) e.currentTarget.style.background = '#18181b' }}
            onMouseLeave={e => { e.currentTarget.style.background = isSolved ? 'rgba(34,211,238,0.03)' : 'transparent' }}
        >
            <FluidCheckbox checked={isSolved} onChange={() => onToggleStatus(p.id, prog?.status ?? 'unsolved')} />
            {titleBlock}
            <DifficultyBadge difficulty={p.difficulty} />
            <CompanyBadges companies={p.company || []} />
        </div>
    )
}


export default function DSAListPage({ filterCompany }) {
    const [searchParams, setSearchParams] = useSearchParams()
    const { user } = useAuth()
    const listRef = useRef(null)
    const isMobile = useMediaQuery('(max-width: 767px)')
    const { isFree, limits } = useTier()

    // Read filters from URL params
    const search = searchParams.get('q') || ''
    const companies = searchParams.get('company') ? searchParams.get('company').split(',') : filterCompany ? [filterCompany] : []
    const difficulties = searchParams.get('difficulty') ? searchParams.get('difficulty').split(',') : []
    const sort = searchParams.get('sort') || 'shuffle'
    const statusFilter = searchParams.get('status') || ''
    const [showMoreFilters, setShowMoreFilters] = useState(false)
    const [searchInput, setSearchInput] = useState(search)
    const [page, setPage] = useState(1)
    const [shuffleSeed, setShuffleSeed] = useState(getOrCreateSeed)

    // Debounce search
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

    // ── Free-tier paywall: TRUE server-side limiting (matches LLD/HLD) ──
    // On free tier the query fetches ONLY `limits.dsa` rows — locked problems
    // (titles, links, difficulty, companies, ids) never enter the browser, the
    // network response, or the React Query cache. The client search/filter/sort
    // below then act only on that ≤5-row preview slice (preview-only, exactly
    // like LLD/HLD). Pro tier is unchanged: fetch the full ~900-row set in
    // 1000-row pages and filter + paginate client-side.
    const { data: allProblems = [], isLoading: probLoading } = useQuery({
        queryKey: ['dsa-problems', isFree ? 'free' : 'pro'],
        queryFn: async () => {
            const normalize = (rows) => (rows || []).map(p => {
                // Normalize company: handle both JSONB array and JSON string
                let company = p.company
                if (typeof company === 'string') {
                    try { company = JSON.parse(company) } catch { company = company ? [company] : [] }
                }
                if (!Array.isArray(company)) company = company ? [String(company)] : []

                // Normalize difficulty to Title Case
                let difficulty = p.difficulty
                if (difficulty) {
                    difficulty = difficulty.charAt(0).toUpperCase() + difficulty.slice(1).toLowerCase()
                }

                return { ...p, company, difficulty }
            })

            if (isFree) {
                const { data, error } = await supabase
                    .from('leetcode_company_problems')
                    .select('id, title, difficulty, link, company, topics')
                    .range(0, limits.dsa - 1)
                if (error) throw error
                return normalize(data)
            }

            const PAGE = 1000
            let all = [], from = 0
            while (true) {
                const { data, error } = await supabase
                    .from('leetcode_company_problems')
                    .select('id, title, difficulty, link, company, topics')
                    .range(from, from + PAGE - 1)
                if (error) throw error
                all = all.concat(normalize(data))
                if ((data || []).length < PAGE) break
                from += PAGE
            }
            return all
        },
        staleTime: 5 * 60 * 1000,
    })

    // Lightweight total for the "N of TOTAL" copy — head request, no rows.
    // Free tier only (pro already has the full list in `allProblems`).
    const { data: total = 0 } = useQuery({
        queryKey: ['dsa-count'],
        queryFn: async () => {
            const { count, error } = await supabase
                .from('leetcode_company_problems')
                .select('*', { count: 'exact', head: true })
            if (error) throw error
            return count || 0
        },
        staleTime: 5 * 60 * 1000,
        enabled: isFree,
    })

    // Parse all distinct topics from CSV topics column
    const allTopics = useMemo(() => {
        const set = new Set()
        allProblems.forEach(p => (p.topics || '').split(',').forEach(t => { const s = t.trim(); if (s) set.add(s) }))
        return Array.from(set).sort()
    }, [allProblems])

    const { progressMap, toggleStatus, toggleBookmark } = useProgress('dsa')

    // Filter + sort client-side
    const filtered = useMemo(() => {
        let list = allProblems

        if (search) {
            const q = search.toLowerCase()
            list = list.filter(p => p.title?.toLowerCase().includes(q) || p.topics?.toLowerCase().includes(q))
        }
        if (difficulties.length) list = list.filter(p => difficulties.includes(p.difficulty))
        if (companies.length) list = list.filter(p => companies.some(c => (p.company || []).includes(c)))
        if (statusFilter === 'solved') list = list.filter(p => progressMap[p.id]?.status === 'solved')
        else if (statusFilter === 'attempted') list = list.filter(p => progressMap[p.id]?.status === 'attempted')
        else if (statusFilter === 'unsolved') list = list.filter(p => !progressMap[p.id] || progressMap[p.id]?.status === 'unsolved')
        else if (statusFilter === 'bookmarked') list = list.filter(p => progressMap[p.id]?.is_bookmarked)

        if (sort === 'shuffle') {
            return seededShuffle(list, shuffleSeed)
        }
        if (sort === 'difficulty') {
            const d = { Easy: 0, Medium: 1, Hard: 2 }
            list = [...list].sort((a, b) => (d[a.difficulty] ?? 3) - (d[b.difficulty] ?? 3))
        }
        else if (sort === 'alpha') list = [...list].sort((a, b) => a.title.localeCompare(b.title))

        return list
    }, [allProblems, search, difficulties, companies, statusFilter, sort, progressMap, shuffleSeed])

    // Pagination
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
    const safePage = Math.min(page, totalPages)
    const pagedItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

    // Free-tier gate: `allProblems` is already capped server-side at `limits.dsa`,
    // so `filtered` here is at most the preview slice. Locked rows are represented
    // only by a generic <LockedSlice> below; `total` (count query) drives the copy.
    const shown = isFree ? filtered.slice(0, limits.dsa) : pagedItems
    const gated = isFree && total > shown.length

    // Counts
    const solved = Object.values(progressMap).filter(r => r.status === 'solved').length

    // Reset page on filter change
    useEffect(() => { setPage(1) }, [search, difficulties.join(','), companies.join(','), statusFilter, sort])

    // Keyboard shortcuts
    useEffect(() => {
        const handler = (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
            if (e.key === '/') { e.preventDefault(); document.getElementById('dsa-search')?.focus() }
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [])

    const pickRandom = () => {
        const unsolved = filtered.filter(p => !progressMap[p.id] || progressMap[p.id]?.status !== 'solved')
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
                                <h1 style={{ fontSize: '1.2rem', fontWeight: 900, color: '#fafafa', letterSpacing: '-0.03em' }}>DSA Problems</h1>
                                <p style={{ color: '#71717a', fontSize: '0.78rem', marginTop: 2 }}>LeetCode company-wise — {isFree ? total : filtered.length} problems</p>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                {/* Progress ring */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#18181b', border: '1px solid #27272a', borderRadius: 8, padding: '6px 12px' }}>
                                    <span style={{ fontSize: '0.72rem', color: '#71717a', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Solved</span>
                                    <span style={{ fontSize: '0.9rem', fontWeight: 900, color: '#22d3ee' }}>{solved}</span>
                                    <span style={{ color: '#3f3f46', fontSize: '0.8rem' }}>/</span>
                                    <span style={{ fontSize: '0.82rem', color: '#a1a1aa' }}>{isFree ? total : allProblems.length}</span>
                                </div>
                                <button onClick={pickRandom} style={{
                                    fontSize: '0.72rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.06em',
                                    padding: '7px 12px', background: 'none', border: '1px solid #27272a', borderRadius: 6,
                                    color: '#f472b6', cursor: 'pointer', whiteSpace: 'nowrap',
                                }}>
                                    🎲 Random
                                </button>
                            </div>
                        </div>

                        {/* Difficulty breakdown */}
                        {allProblems.length > 0 && (
                            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                                {['Easy', 'Medium', 'Hard'].map(d => {
                                    const total = allProblems.filter(p => p.difficulty === d).length
                                    const done = allProblems.filter(p => p.difficulty === d && progressMap[p.id]?.status === 'solved').length
                                    return (
                                        <div key={d} style={{ fontSize: '0.7rem', color: '#71717a', display: 'flex', alignItems: 'center', gap: 4 }}>
                                            <DifficultyBadge difficulty={d} />
                                            <span>{done}/{total}</span>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>

                    {/* --- Filter bar --- */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12, alignItems: 'center' }}>
                        {/* Search */}
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
                                    width: '100%', padding: '8px 10px 8px 32px', background: '#18181b', border: '1px solid #27272a',
                                    borderRadius: 6, color: '#fafafa', font: 'inherit', fontSize: '0.82rem', outline: 'none',
                                }}
                                onFocus={e => e.target.style.borderColor = '#22d3ee'}
                                onBlur={e => e.target.style.borderColor = '#27272a'}
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
                                        padding: '5px 10px', borderRadius: 6, border: `1px solid ${active ? colors[d] : '#27272a'}`,
                                        background: active ? `rgba(${d === 'Easy' ? '74,222,128' : d === 'Medium' ? '250,204,21' : '248,113,113'},0.12)` : 'transparent',
                                        color: active ? colors[d] : '#71717a', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 900,
                                        textTransform: 'uppercase', letterSpacing: '0.06em', transition: 'all 0.15s',
                                    }}>{d}</button>
                                )
                            })}
                        </div>

                        {/* Company selector */}
                        <CompanySelector
                            selected={companies}
                            onChange={v => updateParam('company', v)}
                        />

                        {/* Sort */}
                        <select
                            value={sort}
                            onChange={e => updateParam('sort', e.target.value)}
                            style={{
                                padding: '6px 10px', background: '#18181b', border: '1px solid #27272a', borderRadius: 6,
                                color: '#a1a1aa', font: 'inherit', fontSize: '0.78rem', outline: 'none', cursor: 'pointer',
                            }}
                        >
                            {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>

                        {/* Re-shuffle button (only visible when shuffle is active) */}
                        {sort === 'shuffle' && (
                            <button
                                onClick={() => {
                                    const newSeed = Date.now() & 0x7fffffff
                                    sessionStorage.setItem('dsa_shuffle_seed', String(newSeed))
                                    setShuffleSeed(newSeed)
                                    setPage(1)
                                }}
                                style={{
                                    padding: '6px 12px', background: 'none', border: '1px solid #27272a',
                                    borderRadius: 6, color: '#22d3ee', cursor: 'pointer', fontSize: '0.72rem',
                                    fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.06em',
                                }}
                                title="Re-randomize order"
                            >
                                🔀 Reshuffle
                            </button>
                        )}
                        <button onClick={() => setShowMoreFilters(v => !v)} style={{
                            padding: '6px 12px', background: showMoreFilters ? '#22d3ee' : 'none', border: '1px solid #27272a',
                            borderRadius: 6, color: showMoreFilters ? '#09090b' : '#71717a', cursor: 'pointer', fontSize: '0.72rem',
                            fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.06em',
                        }}>
                            {showMoreFilters ? '▲ Less' : '▼ More'}
                        </button>
                    </div>

                    {/* More filters */}
                    {showMoreFilters && (
                        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 12, padding: '12px 16px', background: '#18181b', border: '1px solid #27272a', borderRadius: 8 }}>
                            <div>
                                <label style={{ fontSize: '0.65rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#71717a', display: 'block', marginBottom: 6 }}>Status</label>
                                <div style={{ display: 'flex', gap: 4 }}>
                                    {['', 'solved', 'attempted', 'unsolved', 'bookmarked'].map(s => (
                                        <button key={s} onClick={() => updateParam('status', s)} style={{
                                            padding: '4px 10px', borderRadius: 5, border: `1px solid ${statusFilter === s ? '#22d3ee' : '#27272a'}`,
                                            background: statusFilter === s ? 'rgba(34,211,238,0.12)' : 'transparent',
                                            color: statusFilter === s ? '#22d3ee' : '#71717a', cursor: 'pointer', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase',
                                        }}>
                                            {s || 'All'}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Table header */}
                    {!isMobile && (
                        <div style={{
                            display: 'grid', gridTemplateColumns: '28px 1fr 90px 1fr',
                            gap: 8, padding: '6px 12px', borderBottom: '1px solid #27272a',
                            fontSize: '0.62rem', fontWeight: 900, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.08em',
                        }}>
                            <span></span>
                            <span>Problem</span>
                            <span>Difficulty</span>
                            <span>Companies</span>
                        </div>
                    )}

                    {/* Virtualized list */}
                    {probLoading ? (
                        <div>
                            {Array.from({ length: 12 }).map((_, i) => (
                                <div key={i} style={{ height: 51, borderBottom: '1px solid #18181b', display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px' }}>
                                    <div style={{ width: 20, height: 20, borderRadius: 4, background: '#27272a' }} />
                                    <div style={{ flex: 1, height: 14, borderRadius: 4, background: '#1e1e22', animation: 'pulse 1.5s ease-in-out infinite' }} />
                                    <div style={{ width: 60, height: 14, borderRadius: 4, background: '#1e1e22' }} />
                                </div>
                            ))}
                        </div>
                    ) : filtered.length === 0 ? (
                        <div style={{ padding: '60px 0', textAlign: 'center' }}>
                            <div style={{ fontSize: '2rem', marginBottom: 12 }}>🔍</div>
                            <p style={{ color: '#71717a', fontSize: '0.9rem' }}>No problems match your filters.</p>
                            <button onClick={() => setSearchParams({})} style={{ marginTop: 12, padding: '6px 16px', background: 'none', border: '1px solid #27272a', borderRadius: 6, color: '#22d3ee', cursor: 'pointer', fontSize: '0.78rem' }}>
                                Clear filters
                            </button>
                        </div>
                    ) : (
                        <>
                            {shown.map(p => (
                                <ProblemRow
                                    key={p.id}
                                    p={p}
                                    prog={progressMap[p.id]}
                                    isMobile={isMobile}
                                    onToggleStatus={toggleStatus}
                                    onToggleBookmark={toggleBookmark}
                                />
                            ))}

                            {gated && (
                                <LockedSlice count={total - shown.length} noun="DSA problems" variant="row" />
                            )}

                            {!isFree && (
                                <Pagination page={safePage} totalPages={totalPages} onChange={p => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }) }} />
                            )}
                        </>
                    )}

                    <div style={{ marginTop: 8, color: '#52525b', fontSize: '0.72rem', textAlign: 'center' }}>
                        {isFree ? (
                            <>
                                Preview: {shown.length} of {Math.max(total, shown.length)}
                                {' — '}
                                <Link to="/pricing" style={{ color: '#22d3ee', textDecoration: 'none', fontWeight: 700 }}>upgrade for all</Link>
                            </>
                        ) : (
                            <>
                                Showing {pagedItems.length} of {filtered.length} · {allProblems.length} total · Press <kbd style={{ border: '1px solid #27272a', borderRadius: 3, padding: '0 4px', fontSize: '0.65rem', color: '#71717a' }}>/</kbd> to search
                            </>
                        )}
                    </div>
                </div>
            </div>
        </>
    )
}

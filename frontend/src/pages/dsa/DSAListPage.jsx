import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { supabase } from '../../lib/supabase'
import { useProgress } from '../../lib/useProgress'
import { useAuth } from '../../contexts/AuthContext'
import Navbar from '../../components/Navbar'
import FluidCheckbox from '../../components/shared/FluidCheckbox'
import DifficultyBadge from '../../components/shared/DifficultyBadge'
import CompanySelector from '../../components/shared/CompanySelector'

const DIFFICULTIES = ['Easy', 'Medium', 'Hard']
const SORT_OPTIONS = [
    { value: 'frequency_desc', label: 'Frequency ↓' },
    { value: 'acceptance_desc', label: 'Acceptance ↓' },
    { value: 'difficulty', label: 'Difficulty' },
    { value: 'alpha', label: 'A–Z' },
]

function FrequencyBar({ value }) {
    const pct = Math.min(100, Math.max(0, value ?? 0))
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 70 }}>
            <div style={{ flex: 1, height: 4, background: '#27272a', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: '#22d3ee', borderRadius: 2, transition: 'width 0.3s' }} />
            </div>
            <span style={{ fontSize: '0.65rem', color: '#71717a', minWidth: 24 }}>{Math.round(pct)}</span>
        </div>
    )
}

function CompanyBadges({ companies = [] }) {
    const [show, setShow] = useState(false)
    const visible = companies.slice(0, 2)
    const extra = companies.slice(2)
    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' }}>
            {visible.map(c => (
                <Link key={c} to={`/dsa/company/${encodeURIComponent(c)}`}
                    style={{ fontSize: '0.62rem', padding: '1px 6px', borderRadius: 4, background: '#27272a', color: '#a1a1aa', border: '1px solid #3f3f46', textDecoration: 'none', whiteSpace: 'nowrap' }}
                    onClick={e => e.stopPropagation()}>{c}</Link>
            ))}
            {extra.length > 0 && (
                <div style={{ position: 'relative' }}>
                    <button
                        onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}
                        style={{ fontSize: '0.62rem', padding: '1px 6px', borderRadius: 4, background: '#27272a', color: '#71717a', border: '1px solid #3f3f46', cursor: 'pointer' }}>
                        +{extra.length}
                    </button>
                    {show && (
                        <div style={{
                            position: 'absolute', bottom: '100%', left: 0, zIndex: 50,
                            background: '#18181b', border: '1px solid #27272a', borderRadius: 6,
                            padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 3,
                            boxShadow: '0 8px 24px rgba(0,0,0,0.5)', minWidth: 120,
                        }}>
                            {extra.map(c => (
                                <Link key={c} to={`/dsa/company/${encodeURIComponent(c)}`}
                                    style={{ fontSize: '0.7rem', color: '#a1a1aa', textDecoration: 'none', whiteSpace: 'nowrap' }}
                                    onClick={e => e.stopPropagation()}>{c}</Link>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

function NotesDrawer({ problemId, initialNotes, onSave, onClose }) {
    const [notes, setNotes] = useState(initialNotes || '')
    return (
        <div style={{ padding: '12px 16px', background: '#0d0d0f', borderTop: '1px solid #27272a' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: '0.7rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#71717a' }}>Notes</span>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => onSave(notes)} style={{ fontSize: '0.7rem', padding: '3px 10px', background: '#22d3ee', color: '#09090b', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 900 }}>Save</button>
                    <button onClick={onClose} style={{ fontSize: '0.7rem', padding: '3px 10px', background: 'none', color: '#71717a', border: '1px solid #27272a', borderRadius: 4, cursor: 'pointer' }}>Close</button>
                </div>
            </div>
            <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Jot your approach, time/space complexity…"
                rows={4}
                style={{
                    width: '100%', background: '#18181b', border: '1px solid #27272a', borderRadius: 6,
                    color: '#fafafa', font: 'inherit', fontSize: '0.82rem', padding: '8px 10px',
                    resize: 'vertical', outline: 'none',
                }}
            />
        </div>
    )
}

export default function DSAListPage({ filterCompany }) {
    const [searchParams, setSearchParams] = useSearchParams()
    const { user } = useAuth()
    const listRef = useRef(null)

    // Read filters from URL params
    const search = searchParams.get('q') || ''
    const companies = searchParams.get('company') ? searchParams.get('company').split(',') : filterCompany ? [filterCompany] : []
    const difficulties = searchParams.get('difficulty') ? searchParams.get('difficulty').split(',') : []
    const sort = searchParams.get('sort') || 'frequency_desc'
    const statusFilter = searchParams.get('status') || ''
    const [showMoreFilters, setShowMoreFilters] = useState(false)
    const [freqRange, setFreqRange] = useState([0, 100])
    const [accRange, setAccRange] = useState([0, 100])
    const [expandedNotes, setExpandedNotes] = useState(null)
    const [searchInput, setSearchInput] = useState(search)

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
    }, [setSearchParams])

    // Fetch all DSA problems (let client filter since dataset might be large but manageable)
    const { data: allProblems = [], isLoading: probLoading } = useQuery({
        queryKey: ['dsa-problems'],
        queryFn: async () => {
            const PAGE = 1000
            let all = [], from = 0
            while (true) {
                const { data, error } = await supabase
                    .from('leetcode_company_problems')
                    .select('id, title, difficulty, link, company, frequency, acceptance_rate, topics')
                    .range(from, from + PAGE - 1)
                if (error) throw error
                all = all.concat(data || [])
                if ((data || []).length < PAGE) break
                from += PAGE
            }
            return all
        },
        staleTime: 5 * 60 * 1000,
    })

    // Parse all distinct topics from CSV topics column
    const allTopics = useMemo(() => {
        const set = new Set()
        allProblems.forEach(p => (p.topics || '').split(',').forEach(t => { const s = t.trim(); if (s) set.add(s) }))
        return Array.from(set).sort()
    }, [allProblems])

    const { progressMap, toggleStatus, toggleBookmark, saveNotes } = useProgress('dsa')

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

        list = list.filter(p => {
            const f = p.frequency ?? 0, a = (p.acceptance_rate ?? 0) * 100
            return f >= freqRange[0] && f <= freqRange[1] && a >= accRange[0] && a <= accRange[1]
        })

        if (sort === 'frequency_desc') list = [...list].sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0))
        else if (sort === 'acceptance_desc') list = [...list].sort((a, b) => (b.acceptance_rate ?? 0) - (a.acceptance_rate ?? 0))
        else if (sort === 'difficulty') {
            const d = { Easy: 0, Medium: 1, Hard: 2 }
            list = [...list].sort((a, b) => (d[a.difficulty] ?? 3) - (d[b.difficulty] ?? 3))
        }
        else if (sort === 'alpha') list = [...list].sort((a, b) => a.title.localeCompare(b.title))

        return list
    }, [allProblems, search, difficulties, companies, statusFilter, sort, progressMap, freqRange, accRange])

    // Counts
    const solved = Object.values(progressMap).filter(r => r.status === 'solved').length

    const virtualizer = useVirtualizer({
        count: filtered.length,
        getScrollElement: () => listRef.current,
        estimateSize: () => 52,
        overscan: 10,
    })

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
                        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                            <div>
                                <h1 style={{ fontSize: '1.2rem', fontWeight: 900, color: '#fafafa', letterSpacing: '-0.03em' }}>DSA Problems</h1>
                                <p style={{ color: '#71717a', fontSize: '0.78rem', marginTop: 2 }}>LeetCode company-wise — {filtered.length} problems</p>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                {/* Progress ring */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#18181b', border: '1px solid #27272a', borderRadius: 8, padding: '6px 12px' }}>
                                    <span style={{ fontSize: '0.72rem', color: '#71717a', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Solved</span>
                                    <span style={{ fontSize: '0.9rem', fontWeight: 900, color: '#22d3ee' }}>{solved}</span>
                                    <span style={{ color: '#3f3f46', fontSize: '0.8rem' }}>/</span>
                                    <span style={{ fontSize: '0.82rem', color: '#a1a1aa' }}>{allProblems.length}</span>
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
                        <div style={{ position: 'relative', flex: '1 1 220px' }}>
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
                                <label style={{ fontSize: '0.65rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#71717a', display: 'block', marginBottom: 6 }}>
                                    Frequency: {freqRange[0]}–{freqRange[1]}
                                </label>
                                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                    <input type="range" min={0} max={100} value={freqRange[0]} onChange={e => setFreqRange([+e.target.value, freqRange[1]])} style={{ accentColor: '#22d3ee' }} />
                                    <input type="range" min={0} max={100} value={freqRange[1]} onChange={e => setFreqRange([freqRange[0], +e.target.value])} style={{ accentColor: '#22d3ee' }} />
                                </div>
                            </div>
                            <div>
                                <label style={{ fontSize: '0.65rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#71717a', display: 'block', marginBottom: 6 }}>
                                    Acceptance: {accRange[0]}–{accRange[1]}%
                                </label>
                                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                    <input type="range" min={0} max={100} value={accRange[0]} onChange={e => setAccRange([+e.target.value, accRange[1]])} style={{ accentColor: '#22d3ee' }} />
                                    <input type="range" min={0} max={100} value={accRange[1]} onChange={e => setAccRange([accRange[0], +e.target.value])} style={{ accentColor: '#22d3ee' }} />
                                </div>
                            </div>
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
                    <div style={{
                        display: 'grid', gridTemplateColumns: '28px 1fr 90px 1fr 80px 70px',
                        gap: 8, padding: '6px 12px', borderBottom: '1px solid #27272a',
                        fontSize: '0.62rem', fontWeight: 900, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.08em',
                    }}>
                        <span></span>
                        <span>Problem</span>
                        <span>Difficulty</span>
                        <span>Companies</span>
                        <span>Frequency</span>
                        <span>Accept %</span>
                    </div>

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
                        <div ref={listRef} style={{ height: 'min(65vh, 600px)', overflowY: 'auto', overflowX: 'hidden' }}>
                            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                                {virtualizer.getVirtualItems().map(vItem => {
                                    const p = filtered[vItem.index]
                                    if (!p) return null
                                    const prog = progressMap[p.id]
                                    const isSolved = prog?.status === 'solved'
                                    const isBookmarked = prog?.is_bookmarked
                                    const hasNotes = expandedNotes === p.id

                                    return (
                                        <div
                                            key={p.id}
                                            style={{
                                                position: 'absolute', top: vItem.start, left: 0, right: 0,
                                            }}
                                        >
                                            <div style={{
                                                display: 'grid', gridTemplateColumns: '28px 1fr 90px 1fr 80px 70px',
                                                gap: 8, padding: '10px 12px', alignItems: 'center',
                                                borderBottom: '1px solid rgba(39,39,42,0.5)',
                                                background: isSolved ? 'rgba(34,211,238,0.03)' : 'transparent',
                                                transition: 'background 0.15s',
                                            }}
                                                onMouseEnter={e => { if (!isSolved) e.currentTarget.style.background = '#18181b' }}
                                                onMouseLeave={e => { e.currentTarget.style.background = isSolved ? 'rgba(34,211,238,0.03)' : 'transparent' }}
                                            >
                                                {/* Checkbox */}
                                                <FluidCheckbox
                                                    checked={isSolved}
                                                    onChange={() => toggleStatus(p.id, prog?.status ?? 'unsolved')}
                                                />

                                                {/* Title */}
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                                                    <a href={p.link} target="_blank" rel="noopener noreferrer"
                                                        style={{
                                                            color: isSolved ? '#71717a' : '#fafafa', textDecoration: 'none',
                                                            fontSize: '0.85rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                                            textDecorationLine: isSolved ? 'line-through' : 'none',
                                                        }}>
                                                        {p.title}
                                                    </a>
                                                    {/* Notes icon */}
                                                    <button onClick={() => setExpandedNotes(hasNotes ? null : p.id)}
                                                        title="Notes"
                                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: prog?.notes ? '#22d3ee' : '#3f3f46', padding: 0, flexShrink: 0 }}>
                                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                                                    </button>
                                                    {/* Bookmark */}
                                                    <button onClick={() => toggleBookmark(p.id)}
                                                        title="Bookmark"
                                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: isBookmarked ? '#facc15' : '#3f3f46', padding: 0, flexShrink: 0 }}>
                                                        <svg width="12" height="12" viewBox="0 0 24 24" fill={isBookmarked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>
                                                    </button>
                                                </div>

                                                {/* Difficulty */}
                                                <DifficultyBadge difficulty={p.difficulty} />

                                                {/* Companies */}
                                                <CompanyBadges companies={p.company || []} />

                                                {/* Frequency bar */}
                                                <FrequencyBar value={p.frequency} />

                                                {/* Acceptance */}
                                                <span style={{ fontSize: '0.78rem', color: '#71717a' }}>
                                                    {p.acceptance_rate != null ? `${Math.round(p.acceptance_rate * 100)}%` : '—'}
                                                </span>
                                            </div>

                                            {/* Notes drawer */}
                                            {hasNotes && (
                                                <NotesDrawer
                                                    problemId={p.id}
                                                    initialNotes={prog?.notes}
                                                    onSave={(notes) => { saveNotes(p.id, notes) }}
                                                    onClose={() => setExpandedNotes(null)}
                                                />
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    )}

                    <div style={{ marginTop: 8, color: '#52525b', fontSize: '0.72rem' }}>
                        {filtered.length} of {allProblems.length} shown · Press <kbd style={{ border: '1px solid #27272a', borderRadius: 3, padding: '0 4px', fontSize: '0.65rem', color: '#71717a' }}>Cmd+K</kbd> to search
                    </div>
                </div>
            </div>
        </>
    )
}

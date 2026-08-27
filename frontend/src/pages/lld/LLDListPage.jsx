import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { useProgress } from '../../lib/useProgress'
import Navbar from '../../components/Navbar'
import FluidCheckbox from '../../components/shared/FluidCheckbox'
import DifficultyBadge from '../../components/shared/DifficultyBadge'
import CompanySelector from '../../components/shared/CompanySelector'

function LLDSkeleton() {
    return Array.from({ length: 8 }).map((_, i) => (
        <div key={i} style={{
            background: '#18181b', border: '1px solid #27272a', borderRadius: 8, padding: 16, height: 120,
            animation: 'pulse 1.5s ease-in-out infinite',
        }} />
    ))
}

export default function LLDListPage() {
    const [searchParams, setSearchParams] = useSearchParams()
    const [search, setSearch] = useState(searchParams.get('q') || '')
    const companies = searchParams.get('company') ? searchParams.get('company').split(',') : []
    const difficulties = searchParams.get('difficulty') ? searchParams.get('difficulty').split(',') : []

    const { data: problems = [], isLoading } = useQuery({
        queryKey: ['lld-problems'],
        queryFn: async () => {
            const { data, error } = await supabase
                .from('lld_problems')
                .select('id, slug, title, requirements, companies, difficulty, created_at')
                .order('created_at', { ascending: false })
            if (error) throw error
            return data || []
        },
        staleTime: 5 * 60 * 1000,
    })

    const { progressMap, toggleStatus } = useProgress('lld')

    const updateParam = (key, value) => {
        setSearchParams(p => {
            const n = new URLSearchParams(p)
            if (!value || (Array.isArray(value) && !value.length)) n.delete(key)
            else n.set(key, Array.isArray(value) ? value.join(',') : value)
            return n
        }, { replace: true })
    }

    const filtered = problems.filter(p => {
        if (search && !p.title?.toLowerCase().includes(search.toLowerCase()) && !p.requirements?.toLowerCase().includes(search.toLowerCase())) return false
        if (companies.length && !companies.some(c => (p.companies || []).includes(c))) return false
        if (difficulties.length && !difficulties.includes(p.difficulty)) return false
        return true
    })

    const solved = Object.values(progressMap).filter(r => r.status === 'solved').length

    return (
        <>
            <Navbar />
            <div style={{ paddingTop: 56, minHeight: '100vh', maxWidth: 1100, margin: '0 auto', padding: '80px 16px 40px' }}>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
                    <div>
                        <h1 style={{ fontSize: '1.2rem', fontWeight: 900, letterSpacing: '-0.03em', color: '#fafafa' }}>LLD Problems</h1>
                        <p style={{ color: '#71717a', fontSize: '0.78rem', marginTop: 2 }}>Low-level design — class diagrams + code walkthroughs</p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#18181b', border: '1px solid #27272a', borderRadius: 8, padding: '6px 12px' }}>
                        <span style={{ fontSize: '0.72rem', color: '#71717a', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Practiced</span>
                        <span style={{ fontSize: '0.9rem', fontWeight: 900, color: '#f472b6' }}>{solved}</span>
                        <span style={{ color: '#3f3f46' }}>/</span>
                        <span style={{ fontSize: '0.82rem', color: '#a1a1aa' }}>{problems.length}</span>
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
                    <div style={{ display: 'flex', gap: 4 }}>
                        {['Easy', 'Medium', 'Hard'].map(d => {
                            const active = difficulties.includes(d)
                            const colors = { Easy: '#4ade80', Medium: '#facc15', Hard: '#f87171' }
                            return (
                                <button key={d} onClick={() => {
                                    const next = active ? difficulties.filter(x => x !== d) : [...difficulties, d]
                                    updateParam('difficulty', next)
                                }} style={{
                                    padding: '5px 10px', borderRadius: 6, border: `1px solid ${active ? colors[d] : '#27272a'}`,
                                    background: active ? `rgba(${d === 'Easy' ? '74,222,128' : d === 'Medium' ? '250,204,21' : '248,113,113'},0.12)` : 'transparent',
                                    color: active ? colors[d] : '#71717a', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 900, textTransform: 'uppercase',
                                }}>
                                    {d}
                                </button>
                            )
                        })}
                    </div>
                </div>

                {/* Card Grid */}
                {isLoading ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
                        <LLDSkeleton />
                    </div>
                ) : filtered.length === 0 ? (
                    <div style={{ padding: '60px 0', textAlign: 'center' }}>
                        <div style={{ fontSize: '2rem', marginBottom: 12 }}>🧩</div>
                        <p style={{ color: '#71717a' }}>No LLD problems match your filters.</p>
                        <button onClick={() => { setSearch(''); setSearchParams({}) }} style={{ marginTop: 12, padding: '6px 16px', background: 'none', border: '1px solid #27272a', borderRadius: 6, color: '#f472b6', cursor: 'pointer', fontSize: '0.78rem' }}>
                            Clear filters
                        </button>
                    </div>
                ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
                        {filtered.map(p => {
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
                                    {/* Top row: checkbox + difficulty + practiced badge */}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <FluidCheckbox
                                            checked={isSolved}
                                            onChange={() => toggleStatus(p.id, prog?.status ?? 'unsolved')}
                                        />
                                        {p.difficulty && <DifficultyBadge difficulty={p.difficulty} />}
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
                                                <span key={c} style={{ fontSize: '0.62rem', padding: '1px 6px', borderRadius: 4, background: '#27272a', color: '#a1a1aa', border: '1px solid #3f3f46' }}>{c}</span>
                                            ))}
                                            {(p.companies || []).length > 3 && (
                                                <span style={{ fontSize: '0.62rem', color: '#52525b' }}>+{p.companies.length - 3}</span>
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
                        })}
                    </div>
                )}
            </div>
        </>
    )
}

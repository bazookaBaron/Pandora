import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useProgress } from '../../lib/useProgress'
import { useAuth } from '../../contexts/AuthContext'
import { apiFetch } from '../../lib/apiClient'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { UpgradeButton } from '../../components/shared/PaywallGate'
import { ErrorState, EmptyState } from '../../components/shared/states'
import Navbar from '../../components/Navbar'
import FluidCheckbox from '../../components/shared/FluidCheckbox'
import DifficultyBadge from '../../components/shared/DifficultyBadge'
import CompanySelector from '../../components/shared/CompanySelector'
import CompanyLogo from '../../components/shared/CompanyLogo'

function HLDSkeleton() {
    return Array.from({ length: 6 }).map((_, i) => (
        <div key={i} style={{
            background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 8, padding: 16, height: 140,
            animation: 'pulse 1.5s ease-in-out infinite',
        }} />
    ))
}

function LockIcon({ size = 13 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
    )
}

export default function HLDListPage() {
    const [searchParams, setSearchParams] = useSearchParams()
    const [search, setSearch] = useState(searchParams.get('q') || '')
    const isMobile = useMediaQuery('(max-width: 767px)')
    const { user } = useAuth()
    const companies = searchParams.get('company') ? searchParams.get('company').split(',') : []
    const difficulties = searchParams.get('difficulty') ? searchParams.get('difficulty').split(',') : []

    // ── Authenticated catalog query ───────────────────────────────────
    // The server returns the FULL list to every tier, but a free user
    // (`access: 'list_only'`) gets each item stripped to id/title/companies/
    // difficulty with `locked: true` and no description/slug — enough to browse,
    // nothing to practice with. Pro/max get full rows + `access: 'full'`.
    const { data, isLoading, isError, error, refetch } = useQuery({
        queryKey: ['catalog-hld'],
        queryFn: () => apiFetch('/api/catalog/hld'),
        enabled: !!user,
        staleTime: 5 * 60 * 1000,
    })

    const items = data?.items || []
    const total = data?.total ?? items.length
    const access = data?.access || 'list_only'
    const listOnly = access === 'list_only'

    const { progressMap, toggleStatus } = useProgress('hld')

    const updateParam = (key, value) => {
        setSearchParams(p => {
            const n = new URLSearchParams(p)
            if (!value || (Array.isArray(value) && !value.length)) n.delete(key)
            else n.set(key, Array.isArray(value) ? value.join(',') : value)
            return n
        }, { replace: true })
    }

    const filtered = items.filter(p => {
        if (search && !p.title?.toLowerCase().includes(search.toLowerCase()) && !(p.description || '').toLowerCase().includes(search.toLowerCase())) return false
        if (difficulties.length && !difficulties.includes(p.difficulty)) return false
        if (companies.length && !companies.some(c => (p.companies || []).includes(c))) return false
        return true
    })

    const attempted = Object.values(progressMap).filter(r => r.status === 'solved').length
    const gridCols = isMobile ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))'
    const DIFF_COLORS = { Easy: '#4ade80', Medium: '#facc15', Hard: '#f87171' }

    // Locked card (free / list_only) — muted, non-interactive target is /pricing.
    const renderLockedCard = (p) => (
        <Link key={p.id} to="/pricing" style={{
            textDecoration: 'none', background: '#141416', border: '1px solid var(--subtle)',
            borderRadius: 8, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
            opacity: 0.72, transition: 'opacity 0.15s, border-color 0.15s',
        }}
            onMouseEnter={e => { e.currentTarget.style.opacity = 1; e.currentTarget.style.borderColor = 'var(--subtle-strong)' }}
            onMouseLeave={e => { e.currentTarget.style.opacity = 0.72; e.currentTarget.style.borderColor = 'var(--subtle)' }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {p.difficulty && <DifficultyBadge difficulty={p.difficulty} />}
                <span style={{ marginLeft: 'auto', color: '#a78bfa', display: 'flex', alignItems: 'center' }}><LockIcon /></span>
            </div>
            <h3 style={{ fontSize: '0.92rem', fontWeight: 900, color: 'var(--accent)', letterSpacing: '-0.02em', lineHeight: 1.3 }}>
                {p.title}
            </h3>
            {(p.companies || []).length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {(p.companies || []).slice(0, 4).map(c => <CompanyLogo key={c} company={c} />)}
                    {(p.companies || []).length > 4 && (
                        <span style={{ fontSize: '0.62rem', color: 'var(--faint)', alignSelf: 'center' }}>+{p.companies.length - 4}</span>
                    )}
                </div>
            )}
            <span style={{
                marginTop: 4, fontSize: '0.72rem', fontWeight: 900, color: '#a78bfa',
                textTransform: 'uppercase', letterSpacing: '0.06em', display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
                <LockIcon size={12} /> Unlock to practice
            </span>
        </Link>
    )

    // Full card (pro / max)
    const renderCard = (p) => {
        const prog = progressMap[p.id]
        const isAttempted = prog?.status === 'solved'
        return (
            <div key={p.id} style={{
                background: 'var(--panel)', border: `1px solid ${isAttempted ? 'rgba(167,139,250,0.3)' : 'var(--subtle)'}`,
                borderRadius: 8, padding: '14px 16px', position: 'relative',
                transition: 'border-color 0.15s, transform 0.15s',
                display: 'flex', flexDirection: 'column', gap: 10,
            }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = isAttempted ? 'rgba(167,139,250,0.5)' : 'var(--subtle-strong)' }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.borderColor = isAttempted ? 'rgba(167,139,250,0.3)' : 'var(--subtle)' }}
            >
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

                <Link to={`/hld/${p.slug || p.id}`} style={{ textDecoration: 'none' }}>
                    <h3 style={{
                        fontSize: '0.92rem', fontWeight: 900, color: isAttempted ? 'var(--muted)' : 'var(--bright)',
                        letterSpacing: '-0.02em', lineHeight: 1.3,
                    }}>
                        {p.title}
                    </h3>
                </Link>

                {p.description && (
                    <p style={{
                        fontSize: '0.73rem', color: 'var(--muted)', lineHeight: 1.5,
                        overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    }}>
                        {p.description.replace(/[#*`]/g, '').slice(0, 130)}…
                    </p>
                )}

                {(p.companies || []).length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {(p.companies || []).slice(0, 4).map(c => (
                            <CompanyLogo key={c} company={c} />
                        ))}
                        {(p.companies || []).length > 4 && (
                            <span style={{ fontSize: '0.62rem', color: 'var(--faint)', alignSelf: 'center' }}>+{p.companies.length - 4}</span>
                        )}
                    </div>
                )}

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
                        <h1 style={{ fontSize: '1.2rem', fontWeight: 900, letterSpacing: '-0.03em', color: 'var(--bright)' }}>HLD Questions</h1>
                        <p style={{ color: 'var(--muted)', fontSize: '0.78rem', marginTop: 2 }}>High-level system design — architecture, scalability, trade-offs</p>
                    </div>
                    {!listOnly && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 8, padding: '6px 12px' }}>
                            <span style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Attempted</span>
                            <span style={{ fontSize: '0.9rem', fontWeight: 900, color: '#a78bfa' }}>{attempted}</span>
                            <span style={{ color: 'var(--subtle-strong)' }}>/</span>
                            <span style={{ fontSize: '0.82rem', color: 'var(--accent)' }}>{total}</span>
                        </div>
                    )}
                </div>

                {/* Free-tier banner */}
                {listOnly && !isLoading && !isError && (
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                        background: '#141416', border: '1px solid var(--subtle)', borderRadius: 8,
                        padding: '12px 16px', marginBottom: 20,
                    }}>
                        <span style={{ color: '#a78bfa', display: 'flex', alignItems: 'center' }}><LockIcon size={16} /></span>
                        <span style={{ fontSize: '0.8rem', color: 'var(--accent)', flex: 1, minWidth: 180 }}>
                            HLD practice is a Pro feature — you can browse the list.
                        </span>
                        <UpgradeButton size="sm" />
                    </div>
                )}

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
                                width: '100%', padding: '8px 10px 8px 32px', background: 'var(--panel)', border: '1px solid var(--subtle)',
                                borderRadius: 6, color: 'var(--bright)', font: 'inherit', fontSize: '0.82rem', outline: 'none',
                            }}
                            onFocus={e => e.target.style.borderColor = '#a78bfa'}
                            onBlur={e => e.target.style.borderColor = 'var(--subtle)'}
                        />
                    </div>

                    <div style={{ display: 'flex', gap: 4 }}>
                        {['Easy', 'Medium', 'Hard'].map(d => {
                            const active = difficulties.includes(d)
                            return (
                                <button key={d} onClick={() => {
                                    const next = active ? difficulties.filter(x => x !== d) : [...difficulties, d]
                                    updateParam('difficulty', next)
                                }} style={{
                                    padding: '5px 10px', borderRadius: 6, border: `1px solid ${active ? DIFF_COLORS[d] : 'var(--subtle)'}`,
                                    background: active ? `${DIFF_COLORS[d]}1F` : 'transparent',
                                    color: active ? DIFF_COLORS[d] : 'var(--muted)', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 900,
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
                ) : isError ? (
                    <ErrorState
                        title="Could not load HLD questions."
                        err={error}
                        onRetry={() => refetch()}
                    />
                ) : filtered.length === 0 ? (
                    <EmptyState
                        icon="🏗️"
                        title="No HLD questions match your filters."
                        action={(
                            <button onClick={() => { setSearch(''); setSearchParams({}) }} style={{ padding: '6px 16px', background: 'none', border: '1px solid var(--subtle)', borderRadius: 6, color: '#a78bfa', cursor: 'pointer', fontSize: '0.78rem' }}>
                                Clear filters
                            </button>
                        )}
                    />
                ) : (
                    <>
                        <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 12 }}>
                            {filtered.map(listOnly ? renderLockedCard : renderCard)}
                        </div>
                        <div style={{ textAlign: 'center', marginTop: 12, color: 'var(--faint)', fontSize: '0.72rem' }}>
                            {filtered.length} of {total} questions
                        </div>
                    </>
                )}
            </div>
        </>
    )
}

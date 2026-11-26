import { useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import Pagination from '../../components/shared/Pagination'
import { useQuery } from '@tanstack/react-query'
import { useProgress } from '../../lib/useProgress'
import { useAuth } from '../../contexts/AuthContext'
import { apiFetch } from '../../lib/apiClient'
import { consumeInitialData } from '../../lib/initialData'
import { UpgradeButton } from '../../components/shared/PaywallGate'
import { ErrorState, EmptyState } from '../../components/shared/states'
import Navbar from '../../components/Navbar'
import FluidCheckbox from '../../components/shared/FluidCheckbox'
import DifficultyBadge, { DIFFICULTY_TONE } from '../../components/shared/DifficultyBadge'
import CompanySelector from '../../components/shared/CompanySelector'
import CompanyLogo from '../../components/shared/CompanyLogo'
import { Pill, SearchInput, Button } from '../../components/ui'
import { ArrowRight, Check, CheckCircle2, Lock } from 'lucide-react'

function HLDSkeleton() {
    return Array.from({ length: 6 }).map((_, i) => <div key={i} className="pr-card-skel" />)
}

export default function HLDListPage() {
    const [searchParams, setSearchParams] = useSearchParams()
    const [search, setSearch] = useState(searchParams.get('q') || '')
    const { user } = useAuth()
    const companies = searchParams.get('company') ? searchParams.get('company').split(',') : []
    const difficulties = searchParams.get('difficulty') ? searchParams.get('difficulty').split(',') : []

    // ── Authenticated catalog query ───────────────────────────────────
    // The server returns the FULL list to every tier, but a free user
    // (`access: 'list_only'`) gets each item stripped to id/title/companies/
    // difficulty with `locked: true` and no description/slug — enough to browse,
    // nothing to practice with. Pro/max get full rows + `access: 'full'`.
    // queryKey never varies with search/company/difficulty (those filter the
    // fetched list client-side), so — unlike DSA/LLD — no "is this the
    // default view" guard is needed: the server-embedded snapshot always
    // matches what this key would fetch anyway.
    const { data, isLoading, isError, error, refetch } = useQuery({
        queryKey: ['catalog-hld'],
        queryFn: () => apiFetch('/api/catalog/hld'),
        staleTime: 5 * 60 * 1000,
        initialData: () => consumeInitialData('hldList'),
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

    // Pagination — same page size + control as the LLD panel (12/page).
    const HLD_PAGE_SIZE = 12
    const [page, setPage] = useState(1)
    const pageCount = Math.max(1, Math.ceil(filtered.length / HLD_PAGE_SIZE))
    useEffect(() => { setPage(1) }, [search, searchParams.get('company'), searchParams.get('difficulty')])
    const safePage = Math.min(page, pageCount)
    const pageItems = filtered.slice((safePage - 1) * HLD_PAGE_SIZE, safePage * HLD_PAGE_SIZE)

    const attempted = Object.values(progressMap).filter(r => r.status === 'solved').length
    const logos = (cos = []) => cos.length > 0 && (
        <div className="pr-card-logos">
            {cos.slice(0, 4).map(c => <CompanyLogo key={c} company={c} />)}
            {cos.length > 4 && <span className="pr-plus">+{cos.length - 4}</span>}
        </div>
    )

    // Locked card (free / list_only) — the whole card links to /pricing.
    const renderLockedCard = (p) => (
        <Link key={p.id} to="/pricing" className="pr-card sys-locked" role="listitem" aria-label={`${p.title} (locked, upgrade to practice)`}>
            <div className="pr-card-top">
                {p.difficulty && <DifficultyBadge difficulty={p.difficulty} />}
                <span className="pr-lock-ic"><Lock size={14} aria-hidden="true" /></span>
            </div>
            <h3 className="pr-card-title">{p.title}</h3>
            {logos(p.companies)}
            <span className="pr-card-cta sys-locked-cta pr-hide-phone">
                <Lock size={12} aria-hidden="true" /><span className="pr-cta-word">Unlock to practice</span>
            </span>
        </Link>
    )

    // Full card (pro / max)
    const renderCard = (p) => {
        const prog = progressMap[p.id]
        const isAttempted = prog?.status === 'solved'
        const to = `/hld/${p.slug || p.id}`
        return (
            <div key={p.id} className={`pr-card tone-plan${isAttempted ? ' is-done' : ''}`} role="listitem">
                <div className="pr-card-top">
                    <FluidCheckbox
                        checked={isAttempted}
                        onChange={() => toggleStatus(p.id, prog?.status ?? 'unsolved')}
                    />
                    {p.difficulty && <DifficultyBadge difficulty={p.difficulty} />}
                    {isAttempted && <Pill tone="plan" icon={Check}>Attempted</Pill>}
                </div>

                <Link to={to} className="pr-card-link">
                    <h3 className="pr-card-title">{p.title}</h3>
                </Link>

                {p.description && (
                    <p className="pr-card-desc">{p.description.replace(/[#*`]/g, '').slice(0, 130)}…</p>
                )}

                {logos(p.companies)}

                <Link to={to} className="pr-card-cta" aria-label={`Design: ${p.title}`}>
                    <span className="pr-cta-word">Design</span><ArrowRight size={13} aria-hidden="true" />
                </Link>
            </div>
        )
    }

    return (
        <>
            <Navbar />
            <div className="has-tilebar" style={{ minHeight: '100vh' }}>
                <div className="pr-page is-narrow">
                    {/* Header */}
                    <div className="pr-head">
                        <div>
                            <h1 className="pg-title">HLD Questions</h1>
                            <p className="pg-subtitle">System design: architecture, scale, trade-offs</p>
                        </div>
                        {!listOnly && (
                            <div className="pg-stat tone-plan" aria-label={`${attempted} of ${total} attempted`}>
                                <CheckCircle2 size={14} className="tone-text" aria-hidden="true" />
                                <span className="pg-stat-label">Attempted</span>
                                <span className="pg-stat-value tone-text">{attempted}</span>
                                <span className="pg-stat-sep">/</span>
                                <span className="pg-stat-total">{total}</span>
                            </div>
                        )}
                    </div>

                    {/* Free-tier banner */}
                    {listOnly && !isLoading && !isError && (
                        <div className="sys-locked pr-banner">
                            <Lock size={16} className="sys-locked-icon" aria-hidden="true" />
                            <span className="sys-locked-title">HLD practice is a Pro feature.</span>
                            <UpgradeButton size="sm" />
                        </div>
                    )}

                    {/* Filters */}
                    <div className="pr-filters">
                        <SearchInput
                            label="Search HLD questions"
                            tone="plan"
                            value={search}
                            onChange={v => { setSearch(v); updateParam('q', v) }}
                            placeholder="Search HLD questions…"
                        />

                        <div className="pr-toggles" role="group" aria-label="Difficulty">
                            {['Easy', 'Medium', 'Hard'].map(d => {
                                const active = difficulties.includes(d)
                                return (
                                    <button key={d} type="button" aria-pressed={active}
                                        className={`pr-toggle tone-${DIFFICULTY_TONE[d]}`}
                                        onClick={() => {
                                            const next = active ? difficulties.filter(x => x !== d) : [...difficulties, d]
                                            updateParam('difficulty', next)
                                        }}>{d}</button>
                                )
                            })}
                        </div>

                        <CompanySelector selected={companies} onChange={v => updateParam('company', v)} />
                    </div>

                    {/* Card Grid */}
                    {isLoading ? (
                        <div className="pr-cards" role="status" aria-label="Loading HLD questions">
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
                            art="diagram"
                            tone="plan"
                            title="No HLD questions match your filters."
                            action={<Button onClick={() => { setSearch(''); setSearchParams({}) }}>Clear filters</Button>}
                        />
                    ) : (
                        <>
                            <div className="pr-cards" role="list" aria-label="HLD questions">
                                {pageItems.map(listOnly ? renderLockedCard : renderCard)}
                            </div>
                            <Pagination
                                page={safePage}
                                totalPages={pageCount}
                                accent="var(--sys-plan)"
                                label="HLD pages"
                                onChange={p => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                            />
                            <div className="pr-foot" aria-live="polite">
                                {pageItems.length} of {filtered.length}{pageCount > 1 ? ` · page ${safePage} of ${pageCount}` : ''}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </>
    )
}

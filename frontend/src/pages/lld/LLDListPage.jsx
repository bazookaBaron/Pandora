import { useState, useEffect, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useProgress } from '../../lib/useProgress'
import { useAuth } from '../../contexts/AuthContext'
import { apiFetch } from '../../lib/apiClient'
import { consumeInitialData } from '../../lib/initialData'
import { LockedSlice } from '../../components/shared/PaywallGate'
import { ErrorState, EmptyState } from '../../components/shared/states'
import Navbar from '../../components/Navbar'
import FluidCheckbox from '../../components/shared/FluidCheckbox'
import CompanySelector from '../../components/shared/CompanySelector'
import CompanyLogo from '../../components/shared/CompanyLogo'
import Pagination from '../../components/shared/Pagination'
import { Pill, SearchInput, Button } from '../../components/ui'
import { ArrowRight, Check, CheckCircle2 } from 'lucide-react'

const PAGE_SIZE = 6

function LLDSkeleton() {
    return Array.from({ length: PAGE_SIZE }).map((_, i) => <div key={i} className="pr-card-skel" />)
}

export default function LLDListPage() {
    const [searchParams, setSearchParams] = useSearchParams()
    const { user } = useAuth()
    const search = searchParams.get('q') || ''
    const [searchInput, setSearchInput] = useState(search)
    const [page, setPage] = useState(1)
    const companies = searchParams.get('company') ? searchParams.get('company').split(',') : []
    const companyKey = companies.join(',')

    // Debounce the search box → URL param (300ms) so it feeds the query key
    // without a request per keystroke.
    const searchDebounce = useRef(null)
    // A pending debounced setSearchParams must not fire after leaving the page
    // (it would navigate the user back to this list).
    useEffect(() => () => clearTimeout(searchDebounce.current), [])
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

    // Server only embeds the anonymous/free-tier DEFAULT view — only seed
    // from it when the current key actually is that default.
    const isDefaultView = !search && !companyKey && page === 1

    const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
        queryKey: ['catalog-lld', { search, company: companyKey, page }],
        queryFn: () => apiFetch('/api/catalog/lld?' + qs.toString()),
        placeholderData: keepPreviousData,
        staleTime: 60 * 1000,
        ...(isDefaultView ? { initialData: () => consumeInitialData('lldList') } : null),
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

    const renderCard = (p) => {
        const prog = progressMap[p.id]
        const isSolved = prog?.status === 'solved'
        const cos = p.companies || []
        return (
            <div key={p.id} className={`pr-card tone-attention${isSolved ? ' is-done' : ''}`} role="listitem">
                <div className="pr-card-top">
                    <FluidCheckbox
                        checked={isSolved}
                        onChange={() => toggleStatus(p.id, prog?.status ?? 'unsolved')}
                    />
                    {isSolved && <Pill tone="attention" icon={Check}>Practiced</Pill>}
                </div>

                <Link to={`/lld/${p.slug}`} className="pr-card-link">
                    <h3 className="pr-card-title">{p.title}</h3>
                </Link>

                {p.requirements && (
                    <p className="pr-card-desc">{p.requirements.replace(/[#*`]/g, '').slice(0, 120)}…</p>
                )}

                {cos.length > 0 && (
                    <div className="pr-card-logos">
                        {cos.slice(0, 3).map(c => <CompanyLogo key={c} company={c} />)}
                        {cos.length > 3 && <span className="pr-plus">+{cos.length - 3}</span>}
                    </div>
                )}

                <Link to={`/lld/${p.slug}`} className="pr-card-cta" aria-label={`Open IDE: ${p.title}`}>
                    <span className="pr-cta-word">Open IDE</span><ArrowRight size={13} aria-hidden="true" />
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
                            <h1 className="pg-title">LLD Problems</h1>
                            <p className="pg-subtitle">Class diagrams and code walkthroughs</p>
                        </div>
                        <div className="pg-stat tone-attention" aria-label={`${solved} of ${total} practiced`}>
                            <CheckCircle2 size={14} className="tone-text" aria-hidden="true" />
                            <span className="pg-stat-label">Practiced</span>
                            <span className="pg-stat-value tone-text">{solved}</span>
                            <span className="pg-stat-sep">/</span>
                            <span className="pg-stat-total">{total}</span>
                        </div>
                    </div>

                    {/* Filters */}
                    <div className="pr-filters">
                        <SearchInput
                            label="Search LLD problems"
                            tone="attention"
                            value={searchInput}
                            onChange={updateSearch}
                            placeholder="Search LLD problems…"
                        />
                        <CompanySelector selected={companies} onChange={v => updateParam('company', v)} />
                    </div>

                    {/* Card Grid */}
                    {isLoading ? (
                        <div className="pr-cards" role="status" aria-label="Loading LLD problems">
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
                            art="diagram"
                            tone="attention"
                            title="No LLD problems match your filters."
                            action={<Button onClick={() => { setSearchInput(''); setSearchParams({}); setPage(1) }}>Clear filters</Button>}
                        />
                    ) : (
                        <>
                            <div className={`pr-cards${isFetching ? ' is-fetching' : ''}`} role="list" aria-label="LLD problems" aria-busy={isFetching || undefined}>
                                {items.map(renderCard)}
                            </div>

                            {locked > 0 && (
                                <LockedSlice count={locked} noun="LLD problems" variant="card" />
                            )}

                            {pageCount > 1 && (
                                <Pagination page={data?.page ?? page} totalPages={pageCount} label="LLD pages"
                                    onChange={p => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }) }} />
                            )}

                            <div className="pr-foot" aria-live="polite">
                                {unlimited
                                    ? `${items.length} of ${filteredCount}${pageCount > 1 ? ` · page ${data?.page ?? page} of ${pageCount}` : ''}`
                                    : <>Preview: {items.length} of {total} · <Link to="/pricing">upgrade for all</Link></>}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </>
    )
}

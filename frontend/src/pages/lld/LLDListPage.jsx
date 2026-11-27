import { useState, useEffect, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { SlidersHorizontal } from 'lucide-react'
import { useProgress } from '../../lib/useProgress'
import { apiFetch } from '../../lib/apiClient'
import { consumeInitialData } from '../../lib/initialData'
import { useAuth } from '../../contexts/AuthContext'
import { LockedSlice } from '../../components/shared/PaywallGate'
import { ErrorState, EmptyState } from '../../components/shared/states'
import Navbar from '../../components/Navbar'
import CompanySelector from '../../components/shared/CompanySelector'
import Pagination from '../../components/shared/Pagination'
import { PageContainer } from '../../components/shared/Layout'
import { SearchInput, Button, PageHeader, Progress, Sheet, HelpChip } from '../../components/ui'
import { CheckRow } from '../../components/interview/PrepList'
import { track as trackUi, TRACK } from '../../lib/track'
import { TERMS } from '../../lib/copy'

const PAGE_SIZE = 6

export default function LLDListPage() {
    const [searchParams, setSearchParams] = useSearchParams()
    const { user } = useAuth()
    const search = searchParams.get('q') || ''
    const [searchInput, setSearchInput] = useState(search)
    const [page, setPage] = useState(1)
    const [filtersOpen, setFiltersOpen] = useState(false)
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
    const unlimited = data?.limit === 'unlimited'

    const { progressMap, toggleStatus } = useProgress('lld')
    const solved = Object.values(progressMap).filter(r => r.status === 'solved').length

    useEffect(() => { setPage(1) }, [search, companyKey])

    return (
        <>
            <Navbar />
            <PageContainer width="sm" className="pr-list">
                <PageHeader
                    section="prepare"
                    back={{ to: '/prepare', label: 'Prepare' }}
                    title={TERMS.lld.one}
                    subtitle="Design the classes for one feature"
                    aside={<HelpChip term="lld" />}
                >
                    {user && total > 0 && (
                        <Progress value={solved} max={total} tone="success" thin text={`${solved}/${total} practised`} label="Low-level design problems practised" />
                    )}
                </PageHeader>

                <div className="pr-bar">
                    <SearchInput
                        className="pr-bar-main"
                        label="Search low-level design problems"
                        value={searchInput}
                        onChange={updateSearch}
                        placeholder="Parking lot, cache…"
                    />
                    <button type="button" className={`pr-chip pr-chip-btn${companies.length ? ' is-on' : ''}`}
                        onClick={() => setFiltersOpen(true)} aria-haspopup="dialog"
                        aria-label={companies.length ? `Company filter, ${companies.length} on` : 'Filter by company'}>
                        <SlidersHorizontal size={16} aria-hidden="true" />
                        {companies.length > 0 && <span className="pr-chip-count">{companies.length}</span>}
                    </button>
                </div>

                <Sheet open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters"
                    footer={<button type="button" className="sys-tone-btn is-block pr-tone" onClick={() => setFiltersOpen(false)}>Show problems</button>}>
                    <div className="pr-sheet">
                        <div className="pr-fs">
                            <span className="pr-fs-label">Company</span>
                            <CompanySelector selected={companies} onChange={v => updateParam('company', v)} />
                        </div>
                    </div>
                </Sheet>

                {isLoading ? (
                    <ul className="sys-rows" role="status" aria-label="Loading problems">
                        {Array.from({ length: PAGE_SIZE }).map((_, i) => (
                            <li key={i} className="pr-skel"><i style={{ width: 20, height: 20 }} /><i style={{ flex: 1 }} /></li>
                        ))}
                    </ul>
                ) : isError ? (
                    <ErrorState title="Could not load the problems." err={error} onRetry={() => refetch()} />
                ) : items.length === 0 ? (
                    <EmptyState
                        art="diagram"
                        tone="attention"
                        title="No problems match."
                        action={<Button onClick={() => { setSearchInput(''); setSearchParams({}); setPage(1) }}>Clear filters</Button>}
                    />
                ) : (
                    <>
                        <ul className={`sys-rows pr-rows${isFetching ? ' is-fetching' : ''}`} aria-label="Low-level design problems" aria-busy={isFetching || undefined}>
                            {items.map(p => {
                                const prog = progressMap[p.id]
                                const isSolved = prog?.status === 'solved'
                                return (
                                    <CheckRow
                                        key={p.id}
                                        checked={isSolved}
                                        onToggle={() => toggleStatus(p.id, prog?.status ?? 'unsolved')}
                                        checkLabel={isSolved ? `Mark ${p.title} as not practised` : `Mark ${p.title} as practised`}
                                        title={p.title}
                                        difficulty={p.difficulty}
                                        to={`/lld/${p.slug}`}
                                    />
                                )
                            })}
                        </ul>

                        {locked > 0 && <LockedSlice count={locked} noun="low-level design problems" variant="row" />}

                        {pageCount > 1 && (
                            <Pagination page={data?.page ?? page} totalPages={pageCount} accent="var(--green)" label="Problem pages"
                                onChange={p => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }) }} />
                        )}

                        {!unlimited && (
                            <p className="pr-foot" aria-live="polite">
                                Showing {items.length} of {total} · <Link to="/pricing"
                                    onClick={() => trackUi(TRACK.CTA_CLICK, { id: 'lld_see_all', section: 'prepare' })}>Get all problems</Link>
                            </p>
                        )}
                    </>
                )}
            </PageContainer>
        </>
    )
}

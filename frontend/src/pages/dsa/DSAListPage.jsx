import { memo, useState, useEffect, useCallback, useRef, createContext, useContext } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { Lock, Bookmark, CheckCircle2, CircleDot, Shuffle, SlidersHorizontal } from 'lucide-react'
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useProgress } from '../../lib/useProgress'
import { useAuth } from '../../contexts/AuthContext'
import { apiFetch } from '../../lib/apiClient'
import { consumeInitialData } from '../../lib/initialData'
import Navbar from '../../components/Navbar'
import FluidCheckbox from '../../components/shared/FluidCheckbox'
import DifficultyBadge, { DIFFICULTY_TONE } from '../../components/shared/DifficultyBadge'
import CompanySelector from '../../components/shared/CompanySelector'
import CompanyLogo from '../../components/shared/CompanyLogo'
import Pagination from '../../components/shared/Pagination'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { LockedSlice } from '../../components/shared/PaywallGate'
import { ErrorState, EmptyState } from '../../components/shared/states'
import { StatTile, StatTiles, Segmented, SearchInput, Button } from '../../components/ui'
import { track, EVENTS } from '../../lib/analytics'

const DIFFICULTIES = ['Easy', 'Medium', 'Hard']
// Server sorts: 'id' (default table order), 'alpha', 'difficulty'. The old
// client-only 'shuffle' is gone — the server has no equivalent.
const SORT_OPTIONS = [
    { value: 'id', label: 'Default' },
    { value: 'alpha', label: 'A–Z' },
    { value: 'difficulty', label: 'Difficulty' },
]
const STATUS_OPTIONS = [
    { value: '', label: 'All' },
    { value: 'solved', label: 'Solved', tone: 'success' },
    { value: 'attempted', label: 'Attempted', tone: 'waiting' },
    { value: 'unsolved', label: 'To do' },
    { value: 'bookmarked', label: 'Saved', tone: 'waiting' },
]

// Clicking a company logo on a row toggles that company in the current filter (no navigation)
const CompanyPickContext = createContext(null)

function CompanyBadges({ companies = [], isMobile = false }) {
    const pick = useContext(CompanyPickContext)
    const [expanded, setExpanded] = useState(false)
    if (!companies.length) return <span className="pr-logos" />

    const limit = isMobile ? 3 : 6
    const overflow = companies.length - limit
    const shown = expanded ? companies : companies.slice(0, limit)

    return (
        <div className={`pr-logos${expanded ? ' is-open' : ''}`}>
            {shown.map(c => {
                const on = pick?.selected.includes(c)
                return (
                    <button key={c} type="button" title={on ? `Remove ${c} from filter` : `Filter by ${c}`}
                        aria-label={on ? `Remove ${c} from filter` : `Filter by ${c}`}
                        className={`pr-logo-btn${pick && pick.selected.length && !on ? ' is-dim' : ''}`}
                        onClick={e => { e.preventDefault(); e.stopPropagation(); pick?.toggle(c) }}>
                        <CompanyLogo company={c} />
                    </button>
                )
            })}
            {overflow > 0 && (
                <button
                    type="button"
                    className="pr-more-btn"
                    onClick={e => { e.stopPropagation(); setExpanded(v => !v) }}
                    title={expanded ? 'Show fewer' : `Show ${overflow} more`}
                    aria-expanded={expanded}
                >
                    {expanded ? '− less' : `+${overflow}`}
                </button>
            )}
        </div>
    )
}

// Placeholder for a company-matched question hidden behind Premium (task 2).
// No title / tags / metadata — only a lock. Roughly matches ProblemRow size.
function LockedQuestionCard({ onClick }) {
    return (
        <button type="button" className="pr-lock-row" onClick={onClick} title="Upgrade to unlock this question">
            <Lock size={14} aria-hidden="true" />
            <span>Premium question</span>
        </button>
    )
}

// Memoised: props are stable per row (useProgress's toggles are stable
// callbacks and untouched rows keep their object identity), so a toggle
// re-renders only the row that changed.
const ProblemRow = memo(function ProblemRow({ p, prog, isMobile, onToggleStatus, onToggleBookmark }) {
    const isSolved = prog?.status === 'solved'
    const isBookmarked = !!prog?.is_bookmarked

    const handleToggleStatus = () => {
        // Fire completion only on the unsolved → solved transition.
        if (prog?.status !== 'solved') {
            track(EVENTS.QUESTION_COMPLETED, { type: 'dsa', problem_id: p.id, difficulty: p.difficulty })
        }
        onToggleStatus(p.id, prog?.status ?? 'unsolved')
    }

    // Left border = difficulty tone (the only difficulty cue on phones).
    const tone = DIFFICULTY_TONE[p.difficulty]
    return (
        <div className={`pr-row pr-grid${tone ? ` tone-${tone}` : ''}${isSolved ? ' is-done' : ''}`} role="listitem">
            <FluidCheckbox checked={isSolved} onChange={handleToggleStatus} />
            <div className="pr-row-title">
                <a href={p.link} target="_blank" rel="noopener noreferrer" className="pr-title"
                    onClick={() => track(EVENTS.QUESTION_STARTED, { type: 'dsa', problem_id: p.id, difficulty: p.difficulty })}>
                    {p.title}
                </a>
                <button type="button" className="pr-bookmark" onClick={() => onToggleBookmark(p.id)}
                    aria-pressed={isBookmarked} aria-label={isBookmarked ? `Remove bookmark: ${p.title}` : `Bookmark ${p.title}`}
                    title="Bookmark">
                    <Bookmark size={12} fill={isBookmarked ? 'currentColor' : 'none'} aria-hidden="true" />
                </button>
            </div>
            <DifficultyBadge difficulty={p.difficulty} />
            <CompanyBadges companies={p.company || []} isMobile={isMobile} />
        </div>
    )
})


export default function DSAListPage({ filterCompany }) {
    const [searchParams, setSearchParams] = useSearchParams()
    const { user } = useAuth()
    const navigate = useNavigate()
    const isMobile = useMediaQuery('(max-width: 767px)')

    // Read filters from URL params. `q` is written on a 300ms debounce below, so
    // reading it back here gives us the debounced search term for the query key.
    const search = searchParams.get('q') || ''
    // 'company' present but empty = the user removed every company (even the page's own one on /dsa/company/X)
    const companies = searchParams.has('company')
        ? (searchParams.get('company') || '').split(',').filter(Boolean)
        : filterCompany ? [filterCompany] : []
    const difficulties = searchParams.get('difficulty') ? searchParams.get('difficulty').split(',') : []
    const sort = searchParams.get('sort') || 'id'
    const statusFilter = searchParams.get('status') || ''
    const [showMoreFilters, setShowMoreFilters] = useState(false)
    const [searchInput, setSearchInput] = useState(search)
    const companyKey = companies.join(',')
    const difficultyKey = difficulties.join(',')

    // Page is tagged with the filter set it was chosen under, so changing any
    // filter falls back to page 1 in the same render (no reset effect => no
    // double fetch for "new filters + stale page").
    const filterKey = JSON.stringify([search, companyKey, difficultyKey, sort, statusFilter])
    const [pageState, setPageState] = useState({ key: filterKey, page: 1 })
    const page = pageState.key === filterKey ? pageState.page : 1
    const setPage = (p) => setPageState({ key: filterKey, page: p })
    const PAGE_SIZE = 50
    // Status filters depend on the user's progress, which the server doesn't
    // know about, so they're applied client-side over the FULL filtered set.
    const statusActive = !!statusFilter

    // Debounce the search box → URL param (300ms).
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

    const updateParam = useCallback((key, value) => {
        setSearchParams(p => {
            const n = new URLSearchParams(p)
            if (key === 'company' && filterCompany && Array.isArray(value) && !value.length) n.set(key, '')
            else if (!value || (Array.isArray(value) && !value.length)) n.delete(key)
            else n.set(key, Array.isArray(value) ? value.join(',') : value)
            return n
        }, { replace: true })
    }, [setSearchParams, filterCompany])

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

    // The server only ever embeds the anonymous/free-tier DEFAULT view (see
    // server.js's catch-all route) — only seed from it when the current
    // query key actually IS that default (e.g. someone landing on
    // /dsa?search=foo shouldn't get seeded with unfiltered data).
    const isDefaultView = !search && !companyKey && !difficultyKey && sort === 'id' && page === 1

    const pageQuery = useQuery({
        queryKey: ['catalog-dsa', { search, company: companyKey, difficulty: difficultyKey, sort, page }],
        queryFn: () => apiFetch('/api/catalog/dsa?' + qs.toString()),
        placeholderData: keepPreviousData,
        staleTime: 60 * 1000,
        enabled: !statusActive,
        ...(isDefaultView ? { initialData: () => consumeInitialData('dsaList') } : null),
    })

    // Status-filter mode: pull every page of the (search/company/difficulty/sort)
    // filtered set once, then filter by progress + paginate in the browser.
    // Tier caps still apply server-side, so free users only ever get their slice.
    const allQuery = useQuery({
        queryKey: ['catalog-dsa-all', { search, company: companyKey, difficulty: difficultyKey, sort }],
        enabled: statusActive,
        staleTime: 60 * 1000,
        queryFn: async () => {
            const url = (n) => {
                const q = new URLSearchParams(qs)
                q.set('page', String(n))
                return '/api/catalog/dsa?' + q.toString()
            }
            const first = await apiFetch(url(1))
            const pages = first?.pageCount ?? 1
            const all = [...(first?.items || [])]
            // small batches keep us well under the catalog rate limiter
            for (let n = 2; n <= pages; n += 4) {
                const batch = []
                for (let k = n; k < n + 4 && k <= pages; k++) batch.push(apiFetch(url(k)))
                const res = await Promise.all(batch)
                res.forEach(r => all.push(...(r?.items || [])))
            }
            return { ...first, items: all, page: 1, pageCount: 1 }
        },
    })

    const { data, isLoading, isError, error, refetch, isFetching } = statusActive ? allQuery : pageQuery

    const items = data?.items || []
    const total = data?.total ?? 0
    const locked = data?.locked ?? 0
    const lockedCount = data?.lockedCount ?? locked
    const companyLock = !!data?.companyLock // free user + company filter → per-question lock cards
    const filteredCount = data?.filteredCount ?? items.length
    const serverPageCount = data?.pageCount ?? 1
    const unlimited = data?.limit === 'unlimited'

    // Warm the next page in the background so "Next" renders from cache.
    const queryClient = useQueryClient()
    const nextPageQs = new URLSearchParams(qs)
    nextPageQs.set('page', String(page + 1))
    const nextPageUrl = '/api/catalog/dsa?' + nextPageQs.toString()
    useEffect(() => {
        if (!data || statusActive || page >= serverPageCount) return
        queryClient.prefetchQuery({
            queryKey: ['catalog-dsa', { search, company: companyKey, difficulty: difficultyKey, sort, page: page + 1 }],
            queryFn: () => apiFetch(nextPageUrl),
            staleTime: 60 * 1000,
        })
    }, [data, page, serverPageCount, statusActive, nextPageUrl, queryClient, search, companyKey, difficultyKey, sort])

    const { progressMap, toggleStatus, toggleBookmark } = useProgress('dsa')

    // Status filters (solved / attempted / unsolved / bookmarked) run over the
    // full filtered set (see allQuery) and are paginated here.
    let filteredItems = items
    if (statusFilter === 'solved') filteredItems = items.filter(p => progressMap[p.id]?.status === 'solved')
    else if (statusFilter === 'attempted') filteredItems = items.filter(p => progressMap[p.id]?.status === 'attempted')
    else if (statusFilter === 'unsolved') filteredItems = items.filter(p => !progressMap[p.id] || progressMap[p.id]?.status === 'unsolved')
    else if (statusFilter === 'bookmarked') filteredItems = items.filter(p => progressMap[p.id]?.is_bookmarked)
    const pageCount = statusActive ? Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE)) : serverPageCount
    const currentPage = statusActive ? Math.min(page, pageCount) : (data?.page ?? page)
    const viewItems = statusActive
        ? filteredItems.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
        : filteredItems

    const solved = Object.values(progressMap).filter(r => r.status === 'solved').length

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

    const companyPick = {
        selected: companies,
        toggle: (c) => updateParam('company', companies.includes(c) ? companies.filter(x => x !== c) : [...companies, c]),
    }


    const progRows = Object.values(progressMap)
    const attemptedCount = progRows.filter(r => r.status === 'attempted').length
    const bookmarkedCount = progRows.filter(r => r.is_bookmarked).length
    const toggleStatusFilter = (s) => updateParam('status', statusFilter === s ? '' : s)

    return (
        <CompanyPickContext.Provider value={companyPick}>
            {/* the company wrapper (DSACompanyPage) renders its own Navbar */}
            {!filterCompany && <Navbar />}
            <div className="has-tilebar" style={{ minHeight: '100vh' }}>
                <div className="pr-page">

                    {/* Header */}
                    <div className="pr-head">
                        <div>
                            <h1 className="pg-title">DSA Problems</h1>
                            <p className="pg-subtitle">LeetCode, company-wise · {total} problems</p>
                        </div>
                        <div className="pr-head-actions">
                            <Button variant="ghost" icon={Shuffle} onClick={pickRandom} title="Open a random unsolved problem">Random</Button>
                        </div>
                    </div>

                    {/* Progress: tiles double as status filters */}
                    <StatTiles cols={3} className="pr-tiles">
                        <StatTile icon={CheckCircle2} label="Solved" value={solved} total={total} tone="success" onClick={() => toggleStatusFilter('solved')} />
                        <StatTile icon={CircleDot} label="Attempted" value={attemptedCount} tone="waiting" onClick={() => toggleStatusFilter('attempted')} />
                        <StatTile icon={Bookmark} label="Saved" value={bookmarkedCount} tone="active" onClick={() => toggleStatusFilter('bookmarked')} />
                    </StatTiles>

                    {/* Difficulty breakdown — over the rows currently in view */}
                    {items.length > 0 && (
                        <div className="pr-breakdown">
                            {DIFFICULTIES.map(d => {
                                const dTotal = items.filter(p => p.difficulty === d).length
                                const done = items.filter(p => p.difficulty === d && progressMap[p.id]?.status === 'solved').length
                                return (
                                    <span key={d}>
                                        <DifficultyBadge difficulty={d} />
                                        {done}/{dTotal}
                                    </span>
                                )
                            })}
                        </div>
                    )}

                    {/* --- Filter bar --- */}
                    <div data-tour="dsa-list" className="pr-filters">
                        <SearchInput
                            id="dsa-search"
                            label="Search DSA problems"
                            value={searchInput}
                            onChange={updateSearch}
                            placeholder={isMobile ? 'Search problems…' : 'Search title or topics… ( / )'}
                        />

                        {/* Difficulty toggles (multi-select) */}
                        <div className="pr-toggles" role="group" aria-label="Difficulty">
                            {DIFFICULTIES.map(d => {
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

                        <CompanySelector
                            selected={companies}
                            onChange={v => updateParam('company', v)}
                        />

                        <select
                            className="sys-select"
                            aria-label="Sort problems"
                            value={sort}
                            onChange={e => updateParam('sort', e.target.value)}
                        >
                            {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>

                        <Button
                            variant={showMoreFilters || statusActive ? 'primary' : 'secondary'}
                            icon={SlidersHorizontal}
                            iconOnly
                            aria-label={showMoreFilters ? 'Hide status filter' : 'Show status filter'}
                            aria-expanded={showMoreFilters}
                            aria-controls="dsa-more-filters"
                            title="Status filter"
                            onClick={() => setShowMoreFilters(v => !v)}
                        />
                    </div>

                    {/* More filters */}
                    {(showMoreFilters || statusActive) && (
                        <div id="dsa-more-filters" className="pr-more">
                            <Segmented
                                label="Status"
                                value={statusFilter}
                                onChange={s => updateParam('status', s)}
                                options={STATUS_OPTIONS}
                            />
                        </div>
                    )}

                    {isLoading ? (
                        <div className="pr-table" role="status" aria-label="Loading problems">
                            {Array.from({ length: 12 }).map((_, i) => (
                                <div key={i} className="pr-skel">
                                    <i style={{ width: 18, height: 18 }} />
                                    <i style={{ flex: 1 }} />
                                    <i style={{ width: 60 }} />
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
                            art="code"
                            tone="active"
                            title="No problems match your filters."
                            action={<Button onClick={() => setSearchParams({})}>Clear filters</Button>}
                        />
                    ) : (
                        <>
                            <div className={`pr-table${isFetching ? ' is-fetching' : ''}`} aria-busy={isFetching || undefined}>
                                {/* Table header */}
                                {!isMobile && (
                                    <div className="pr-thead pr-grid" aria-hidden="true">
                                        <span></span>
                                        <span>Problem</span>
                                        <span>Difficulty</span>
                                        <span>Companies</span>
                                    </div>
                                )}
                                <div role="list" aria-label="DSA problems">
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
                            </div>

                            {companyLock && lockedCount > 0 && (
                                <>
                                    <div className="sys-locked pr-lock-note">
                                        <Lock size={14} className="sys-locked-icon" aria-hidden="true" />
                                        <span className="sys-locked-title"><strong>{lockedCount}</strong> more with Premium</span>
                                        <Link to="/pricing" className="sys-locked-cta">Upgrade</Link>
                                    </div>
                                    <div className="pr-lock-list" style={{ opacity: isFetching ? 0.6 : 1 }}>
                                        {/* one placeholder per hidden question; capped so a company
                                            with hundreds of matches doesn't blow up the DOM. */}
                                        {Array.from({ length: Math.min(lockedCount, 100) }).map((_, i) => (
                                            <LockedQuestionCard key={`lock-${i}`} onClick={() => navigate('/pricing')} />
                                        ))}
                                    </div>
                                </>
                            )}

                            {!companyLock && locked > 0 && (
                                <LockedSlice count={locked} noun="DSA problems" variant="row" />
                            )}

                            {pageCount > 1 && (
                                <Pagination page={currentPage} totalPages={pageCount} accent="var(--sys-active)" label="DSA pages"
                                    onChange={p => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }) }} />
                            )}
                        </>
                    )}

                    {!isLoading && !isError && (
                        <div className="pr-foot" aria-live="polite">
                            {unlimited ? (
                                <>
                                    {statusActive ? filteredItems.length : items.length} of {statusActive ? filteredItems.length : filteredCount}
                                    <span className="pr-kbd-hint"> · Press <kbd>/</kbd> to search</span>
                                </>
                            ) : (
                                <>
                                    Preview: {items.length} of {total} · <Link to="/pricing">upgrade for all</Link>
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </CompanyPickContext.Provider>
    )
}

import { memo, useState, useEffect, useCallback, useRef } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { Lock, Bookmark, Shuffle, SlidersHorizontal } from 'lucide-react'
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useProgress } from '../../lib/useProgress'
import { useAuth } from '../../contexts/AuthContext'
import { apiFetch } from '../../lib/apiClient'
import { consumeInitialData } from '../../lib/initialData'
import Navbar from '../../components/Navbar'
import CompanySelector from '../../components/shared/CompanySelector'
import CompanyLogo from '../../components/shared/CompanyLogo'
import Pagination from '../../components/shared/Pagination'
import { LockedSlice } from '../../components/shared/PaywallGate'
import { ErrorState, EmptyState } from '../../components/shared/states'
import { PageContainer } from '../../components/shared/Layout'
import { SearchInput, Button, PageHeader, Progress, Sheet, HelpChip, NextStep } from '../../components/ui'
import { CheckRow, ChipSelect, difficultyChip } from '../../components/interview/PrepList'
import { track, EVENTS } from '../../lib/analytics'
import { track as trackUi, TRACK } from '../../lib/track'
import { TERMS } from '../../lib/copy'

// Server sorts: 'id' (default table order), 'alpha', 'difficulty'.
const SORT_OPTIONS = [
    { value: 'id', label: 'Default' },
    { value: 'alpha', label: 'A–Z' },
    { value: 'difficulty', label: 'Difficulty' },
]
const STATUS_OPTIONS = [
    { value: '', label: 'All' },
    { value: 'solved', label: 'Solved' },
    { value: 'attempted', label: 'Attempted' },
    { value: 'unsolved', label: 'To do' },
    { value: 'bookmarked', label: 'Saved' },
]

// Same slug rule the server uses for /dsa/company/:slug (sitemap).
const slugify = (s = '') => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const prettyCompany = (s = '') => /[A-Z]/.test(s) ? s : s.split(/[-\s]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ')

// One line: solved checkbox (44px hit) · title · difficulty dot · chevron.
// The bookmark sits outside the link and shows from 768px (keeps "Saved" working).
// Memoised: a toggle re-renders only the row that changed.
const ProblemRow = memo(function ProblemRow({ p, prog, onToggleStatus, onToggleBookmark }) {
    const isSolved = prog?.status === 'solved'
    const isBookmarked = !!prog?.is_bookmarked

    const handleToggleStatus = () => {
        // Fire completion only on the unsolved → solved transition.
        if (prog?.status !== 'solved') {
            track(EVENTS.QUESTION_COMPLETED, { type: 'dsa', problem_id: p.id, difficulty: p.difficulty })
        }
        onToggleStatus(p.id, prog?.status ?? 'unsolved')
    }

    return (
        <CheckRow
            checked={isSolved}
            onToggle={handleToggleStatus}
            checkLabel={isSolved ? `Mark ${p.title} as not solved` : `Mark ${p.title} as solved`}
            title={p.title}
            difficulty={p.difficulty}
            href={p.link}
            target="_blank"
            aria-label={`${p.title}, ${p.difficulty || 'no level'}, opens LeetCode`}
            onClick={() => track(EVENTS.QUESTION_STARTED, { type: 'dsa', problem_id: p.id, difficulty: p.difficulty })}
            extra={
                <button type="button" className="pr-bookmark pr-desk" onClick={() => onToggleBookmark(p.id)}
                    aria-pressed={isBookmarked} aria-label={isBookmarked ? `Remove bookmark: ${p.title}` : `Bookmark ${p.title}`}
                    title="Bookmark">
                    <Bookmark size={14} fill={isBookmarked ? 'currentColor' : 'none'} aria-hidden="true" />
                </button>
            }
        />
    )
})

// Placeholder for a company-matched question hidden behind Premium.
// No title / tags / metadata — only a lock.
function LockedQuestionCard({ onClick }) {
    return (
        <button type="button" className="pr-lock-row" onClick={onClick} title="Upgrade to unlock this question">
            <Lock size={14} aria-hidden="true" />
            <span>Premium question</span>
        </button>
    )
}

export default function DSAListPage({ filterCompany }) {
    const [searchParams, setSearchParams] = useSearchParams()
    const { user } = useAuth()
    const navigate = useNavigate()

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
    const [filtersOpen, setFiltersOpen] = useState(false)
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


    const setDifficulty = (v) => updateParam('difficulty', v ? [v] : [])
    const diffChip = difficultyChip(difficulties)
    const sheetCount = (search ? 1 : 0) + (statusFilter ? 1 : 0) + (sort !== 'id' ? 1 : 0)

    // Company page: proper display name from the rows (slug "google" -> "Google").
    const company = filterCompany
        ? (items.flatMap(p => p.company || []).find(c => slugify(c) === slugify(filterCompany)) || prettyCompany(filterCompany))
        : ''
    const progress = user && total > 0
        ? <Progress value={solved} max={total} tone="success" thin text={`${solved}/${total} solved`} label="DSA questions solved" />
        : null

    return (
        <>
            <Navbar />
            <PageContainer width="sm" className="pr-list">
                {filterCompany ? (
                    <PageHeader
                        section="prepare"
                        back={{ to: '/dsa', label: 'All DSA' }}
                        title={company}
                        subtitle={`DSA questions asked at ${company}`}
                        aside={<CompanyLogo company={company} />}
                    >{progress}</PageHeader>
                ) : (
                    <PageHeader
                        section="prepare"
                        back={{ to: '/prepare', label: 'Prepare' }}
                        title={`${TERMS.dsa.one} questions`}
                        subtitle="Coding questions, sorted by company"
                        aside={<HelpChip term="dsa" />}
                    >{progress}</PageHeader>
                )}

                {/* One row: company search · Difficulty chip · more filters (sheet) */}
                <div data-tour="dsa-list" className="pr-bar">
                    <div className="pr-bar-main">
                        <CompanySelector selected={companies} onChange={v => updateParam('company', v)} />
                    </div>
                    <ChipSelect label="Difficulty" value={diffChip.value} options={diffChip.options}
                        active={difficulties.length > 0} onChange={setDifficulty} />
                    <button type="button" className={`pr-chip pr-chip-btn${sheetCount ? ' is-on' : ''}`}
                        onClick={() => setFiltersOpen(true)} aria-haspopup="dialog"
                        aria-label={sheetCount ? `More filters, ${sheetCount} on` : 'More filters'}>
                        <SlidersHorizontal size={16} aria-hidden="true" />
                        {sheetCount > 0 && <span className="pr-chip-count">{sheetCount}</span>}
                    </button>
                </div>

                <Sheet
                    open={filtersOpen}
                    onClose={() => setFiltersOpen(false)}
                    title="Filters"
                    footer={<button type="button" className="sys-tone-btn is-block pr-tone" onClick={() => setFiltersOpen(false)}>Show questions</button>}
                >
                    <div className="pr-sheet">
                        <SearchInput
                            id="dsa-search"
                            label="Search by title or topic"
                            value={searchInput}
                            onChange={updateSearch}
                            placeholder="Title or topic, e.g. graphs"
                        />
                        <fieldset className="pr-fs">
                            <legend className="pr-fs-label">Status</legend>
                            <div className="pr-toggles is-wrap">
                                {STATUS_OPTIONS.map(o => (
                                    <button key={o.value || 'all'} type="button" className="pr-toggle" aria-pressed={statusFilter === o.value}
                                        onClick={() => updateParam('status', o.value)}>{o.label}</button>
                                ))}
                            </div>
                        </fieldset>
                        <label className="pr-fs">
                            <span className="pr-fs-label">Sort</span>
                            <select className="sys-select" value={sort} onChange={e => updateParam('sort', e.target.value)}>
                                {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                        </label>
                        <Button variant="secondary" icon={Shuffle} block onClick={() => {
                            trackUi(TRACK.CTA_CLICK, { id: 'dsa_random', section: 'prepare' })
                            setFiltersOpen(false)
                            pickRandom()
                        }}>Open a random question</Button>
                    </div>
                </Sheet>

                {isLoading ? (
                    <ul className="sys-rows" role="status" aria-label="Loading questions">
                        {Array.from({ length: 10 }).map((_, i) => (
                            <li key={i} className="pr-skel"><i style={{ width: 20, height: 20 }} /><i style={{ flex: 1 }} /></li>
                        ))}
                    </ul>
                ) : isError ? (
                    <ErrorState title="Could not load DSA questions." err={error} onRetry={() => refetch()} />
                ) : viewItems.length === 0 ? (
                    <EmptyState
                        art="code"
                        tone="active"
                        title="No questions match."
                        action={<Button onClick={() => { setSearchInput(''); setSearchParams({}) }}>Clear filters</Button>}
                    />
                ) : (
                    <>
                        <ul className={`sys-rows pr-rows${isFetching ? ' is-fetching' : ''}`} aria-label="DSA questions" aria-busy={isFetching || undefined}>
                            {viewItems.map(p => (
                                <ProblemRow
                                    key={p.id}
                                    p={p}
                                    prog={progressMap[p.id]}
                                    onToggleStatus={toggleStatus}
                                    onToggleBookmark={toggleBookmark}
                                />
                            ))}
                        </ul>

                        {companyLock && lockedCount > 0 && (
                            <>
                                <div className="sys-locked pr-lock-note">
                                    <Lock size={14} className="sys-locked-icon" aria-hidden="true" />
                                    <span className="sys-locked-title"><strong>{lockedCount}</strong> more with Premium</span>
                                    <Link to="/pricing" className="sys-locked-cta"
                                        onClick={() => trackUi(TRACK.CTA_CLICK, { id: 'dsa_upgrade', section: 'prepare' })}>Upgrade</Link>
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
                            <Pagination page={currentPage} totalPages={pageCount} accent="var(--green)" label="DSA pages"
                                onChange={p => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }) }} />
                        )}
                    </>
                )}

                {!isLoading && !isError && !unlimited && (
                    <p className="pr-foot" aria-live="polite">
                        Showing {items.length} of {total} · <Link to="/pricing"
                            onClick={() => trackUi(TRACK.CTA_CLICK, { id: 'dsa_see_all', section: 'prepare' })}>Get all questions</Link>
                    </p>
                )}

                {/* Prepare -> Jobs bridge. No cheap company -> jobs-hub mapping exists, so this
                    searches the job list for the company name instead of /jobs/company/:slug. */}
                {filterCompany && !isLoading && (
                    <NextStep
                        id={`dsa-company-jobs-${slugify(filterCompany)}`}
                        section="jobs"
                        text={`Want to work at ${company}? See its open jobs.`}
                        cta={{ label: 'View jobs', to: `/?q=${encodeURIComponent(company)}` }}
                    />
                )}
            </PageContainer>
        </>
    )
}

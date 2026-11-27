import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { SlidersHorizontal } from 'lucide-react'
import Navbar from '../../components/Navbar'
import { PageContainer } from '../../components/shared/Layout'
import { useJobs, useSearchRequest } from '../../lib/useJobs'
import { apiFetch } from '../../lib/apiClient'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { AUTOAPPLY_ENABLED } from '../../lib/sections'
import { CTA } from '../../lib/copy'
import { track, TRACK } from '../../lib/track'
import { num } from '../../lib/format'
import MarketAnalytics from './MarketAnalytics'
import JobRow from './JobRow'
import JobSheet from './JobSheet'
import FacetCombobox from './FacetCombobox'
import { SEN_LABEL } from './jobsShared'
import { LoadingState, ErrorState, EmptyState } from '../../components/shared/states'
import { LockedSlice } from '../../components/shared/PaywallGate'
import Pagination from '../../components/shared/Pagination'
import { Button, NextStep, PageHeader, Segmented, Sheet, SmallTabs, TabPanel } from '../../components/ui'
import { useAuth } from '../../contexts/AuthContext'

const LOCATION_TYPES = [
    { value: '', label: 'Any' }, { value: 'remote', label: 'Remote' },
    { value: 'hybrid', label: 'Hybrid' }, { value: 'onsite', label: 'Onsite' },
]
const COMPANY_TYPES = [
    { value: '', label: 'All' }, { value: 'product', label: 'Product' },
    { value: 'startup', label: 'Startup' }, { value: 'service', label: 'Service' },
]
const BRIDGE_AFTER = 10 // rows before the Auto Apply bridge card

// ── Listings tab ───────────────────────────────────────────────────
// Filters live in the URL (?q=&company=&loc=…&page=) so a reload, back
// button or shared link keeps them. Every setter resets the page in the same
// update, so changing a filter never fetches the stale page first.
const FILTER_PARAMS = { search: 'q', company: 'company', locations: 'loc', locationType: 'type', companyType: 'ctype', source: 'source', seniority: 'level', postedWithin: 'posted', sort: 'sort' }

function Field({ label, children }) {
    return (
        <div className="jobs-field">
            <span className="jobs-field-label">{label}</span>
            {children}
        </div>
    )
}

function ListingsView() {
    const [params, setParams] = useSearchParams()
    const search = params.get('q') || ''
    const company = params.get('company') || ''
    const locationParam = params.get('loc') || ''
    const locations = useMemo(() => (locationParam ? locationParam.split(',').filter(Boolean) : []), [locationParam])
    const locationType = params.get('type') || ''
    const companyType = params.get('ctype') || ''
    const source = params.get('source') || ''
    const seniority = params.get('level') || ''
    const postedWithin = params.get('posted') || ''
    const sort = params.get('sort') || 'newest'
    const page = Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1)
    const desktop = useMediaQuery('(min-width: 768px)')
    const [filtersOpen, setFiltersOpen] = useState(false)
    const [job, setJob] = useState(null)

    const setFilter = (name) => (value) => {
        setParams((prev) => {
            const key = FILTER_PARAMS[name]
            const v = Array.isArray(value) ? value.join(',') : String(value ?? '')
            const norm = name === 'sort' && v === 'newest' ? '' : v
            if ((prev.get(key) || '') === norm) return prev // unchanged: keep the page
            const next = new URLSearchParams(prev)
            if (!norm) next.delete(key)
            else next.set(key, norm)
            next.delete('page')
            return next
        }, { replace: true })
    }
    const setSearch = setFilter('search')
    const setCompany = setFilter('company')
    const setLocations = setFilter('locations')
    const setLocationType = setFilter('locationType')
    const setCompanyType = setFilter('companyType')
    const setSource = setFilter('source')
    const setSeniority = setFilter('seniority')
    const setPostedWithin = setFilter('postedWithin')
    const setSort = setFilter('sort')
    const setPage = (fn) => {
        setParams((prev) => {
            const next = new URLSearchParams(prev)
            const cur = Math.max(1, Number.parseInt(prev.get('page') || '1', 10) || 1)
            const n = typeof fn === 'function' ? fn(cur) : fn
            if (n <= 1) next.delete('page')
            else next.set('page', String(n))
            return next
        })
    }
    // Clears what the filter sheet holds (the search text stays).
    const clearFilters = () => {
        setParams((prev) => {
            const next = new URLSearchParams(prev)
            for (const k of ['type', 'ctype', 'source', 'level', 'posted', 'sort', 'page', ...(desktop ? [] : ['company', 'loc'])]) next.delete(k)
            return next
        }, { replace: true })
    }

    const { data, isLoading, isFetching, error, refetch } =
        useJobs({ search, company, location: locationParam, locationType, companyType, source, seniority, postedWithin, sort, page })

    const { user } = useAuth()
    const searchReq = useSearchRequest(!!user)
    const [reqState, setReqState] = useState('')
    const requestMore = async () => {
        setReqState('sending')
        try {
            const country = /united states|usa|\bus\b/i.test(locationParam) ? 'US' : 'IN'
            await apiFetch('/api/jobs/request-search', { json: { titles: [search], country, seniority: seniority || undefined } })
            setReqState('queued')
        } catch (e) {
            setReqState(e && e.status === 429 ? 'limited' : 'error')
        }
        searchReq.refetch()
    }

    const sourceOptions = useMemo(
        () => [{ value: '', label: 'All sources' }, ...(data.facets?.sources || []).map((s) => ({ value: s, label: s }))],
        [data.facets],
    )
    const anyFilter = search || company || locations.length || locationType || companyType || source || seniority || postedWithin
    // Filters inside the sheet (company + locations sit inline from 768px).
    const sheetCount = [!desktop && company, !desktop && locations.length, locationType, companyType, source, seniority, postedWithin, sort !== 'newest' && sort]
        .filter(Boolean).length

    const chips = [
        { id: 'remote', label: 'Remote', on: locationType === 'remote', toggle: () => setLocationType(locationType === 'remote' ? '' : 'remote') },
        { id: 'new', label: 'New today', on: postedWithin === '1', toggle: () => setPostedWithin(postedWithin === '1' ? '' : '1') },
        { id: 'product', label: 'Product companies', on: companyType === 'product', toggle: () => setCompanyType(companyType === 'product' ? '' : 'product') },
    ]

    const companyField = (
        <FacetCombobox field="company" value={company} onChange={setCompany} className="jobs-fc-company"
            label="Company" placeholder="Any company" />
    )
    const locationField = (
        <FacetCombobox field="location" multiple value={locations} onChange={setLocations} className="jobs-fc-loc"
            label="Locations" placeholder="Any location" />
    )

    const items = data.items
    const first = items.slice(0, BRIDGE_AFTER)
    const rest = items.slice(BRIDGE_AFTER)
    const showBridge = AUTOAPPLY_ENABLED && items.length >= BRIDGE_AFTER
    const rows = (list) => (
        <ul className={`sys-rows jobs-rows${isFetching ? ' is-fetching' : ''}`}>
            {list.map((j) => <li key={j.id}><JobRow j={j} onOpen={setJob} /></li>)}
        </ul>
    )

    return (
        <>
            <div className="jobs-search" data-tour="jobs-filters">
                <FacetCombobox field="title" value={search} onChange={setSearch} className="jobs-fc-q"
                    label="Search jobs" placeholder="Search role or company" />
                {desktop && companyField}
                {desktop && locationField}
            </div>

            <div className="jobs-chips" role="group" aria-label="Quick filters">
                <button type="button" className={`jobs-chip is-filters${sheetCount ? ' is-on' : ''}`} aria-haspopup="dialog"
                    onClick={() => setFiltersOpen(true)}>
                    <SlidersHorizontal size={16} aria-hidden="true" />
                    <span>Filters{sheetCount ? ` (${sheetCount})` : ''}</span>
                </button>
                {chips.map((c) => (
                    <button key={c.id} type="button" className={`jobs-chip${c.on ? ' is-on' : ''}`} aria-pressed={c.on} onClick={c.toggle}>
                        {c.label}
                    </button>
                ))}
            </div>

            <Sheet
                open={filtersOpen}
                onClose={() => setFiltersOpen(false)}
                title="Filters"
                footer={(
                    <div className="jobs-filter-foot">
                        <Button variant="ghost" onClick={clearFilters} disabled={!sheetCount}>Clear all</Button>
                        <button type="button" className="sys-tone-btn" onClick={() => {
                            track(TRACK.CTA_CLICK, { id: 'filters_apply', section: 'jobs', count: sheetCount })
                            setFiltersOpen(false)
                        }}>
                            {isFetching ? 'Show jobs' : `Show ${num(data.total)} jobs`}
                        </button>
                    </div>
                )}
            >
                <div className="jobs-filter-body">
                    {!desktop && <Field label="Company">{companyField}</Field>}
                    {!desktop && <Field label="Location">{locationField}</Field>}
                    <Field label="Work type">
                        <Segmented label="Work type" value={locationType} onChange={setLocationType} options={LOCATION_TYPES} />
                    </Field>
                    <Field label="Company type">
                        <Segmented label="Company type" value={companyType} onChange={setCompanyType} options={COMPANY_TYPES} />
                    </Field>
                    <Field label="Experience">
                        <select className="sys-select" aria-label="Experience" value={seniority} onChange={(e) => setSeniority(e.target.value)}>
                            <option value="">Any level</option>
                            {['intern', 'junior', 'mid', 'senior', 'staff', 'principal'].map((s) => (
                                <option key={s} value={s}>{SEN_LABEL[s]}</option>
                            ))}
                        </select>
                    </Field>
                    <Field label="Posted">
                        <select className="sys-select" aria-label="Posted" value={postedWithin} onChange={(e) => setPostedWithin(e.target.value)}>
                            <option value="">Any time</option>
                            <option value="1">Past 24 hours</option>
                        </select>
                    </Field>
                    {sourceOptions.length > 1 && (
                        <Field label="Source">
                            <select className="sys-select" aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)}>
                                {sourceOptions.map((o) => <option key={o.value || 'all'} value={o.value}>{o.label}</option>)}
                            </select>
                        </Field>
                    )}
                    <Field label="Sort">
                        <select className="sys-select" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)}>
                            <option value="newest">Latest first</option>
                            <option value="oldest">Oldest first</option>
                            <option value="company">By company</option>
                        </select>
                    </Field>
                </div>
            </Sheet>

            {isLoading ? (
                <LoadingState label="Loading jobs…" />
            ) : error ? (
                <ErrorState err={error} onRetry={refetch} />
            ) : items.length === 0 ? (
                <EmptyState
                    art="jobs"
                    title={data.notReady ? 'Jobs feed not live yet' : 'No matching jobs'}
                    message={data.notReady ? 'Check back in a few hours.' : (anyFilter ? 'Try fewer filters.' : 'No open jobs right now.')}
                    action={anyFilter && !data.notReady
                        ? <Button onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear filters</Button>
                        : undefined}
                />
            ) : (
                <section aria-labelledby="jobs-results-h" className="jobs-results">
                    <h2 id="jobs-results-h" className="jobs-count">
                        {num(data.total)} {data.total === 1 ? 'job' : 'jobs'}
                        <span className="jobs-updating" aria-live="polite">{isFetching ? ' · Updating…' : ''}</span>
                    </h2>
                    {rows(first)}
                    {showBridge && (
                        <NextStep id="jobs-to-autoapply" section="autoapply" oncePerSession
                            text="Applying to 50 jobs takes hours. Auto Apply does it for you."
                            cta={{ label: CTA.seePacks, to: '/autoapply' }} />
                    )}
                    {rest.length > 0 && rows(rest)}
                    {user && search && !isLoading && data.total < 10 && (
                        <div className="jobs-more">
                            {reqState === 'queued' || searchReq.data?.request?.status === 'queued'
                                ? 'We are searching more sources for this role. Check back later.'
                                : reqState === 'limited' ? 'You can request one extra search per day.'
                                : (
                                    <Button onClick={requestMore} busy={reqState === 'sending'} busyLabel="Requesting…">
                                        Search more for this role
                                    </Button>
                                )}
                        </div>
                    )}
                    {data.locked > 0 && (
                        <LockedSlice count={data.locked} noun="job listings" variant="row" rows={3} />
                    )}
                    <Pagination page={data.page} totalPages={data.pageCount} onChange={(p) => setPage(p)}
                        accent="var(--accent)" label="Job pages" />
                </section>
            )}

            <JobSheet job={job} onClose={() => setJob(null)} />
        </>
    )
}

// ── page ───────────────────────────────────────────────────────────
const TABS = [
    { value: 'listings', label: 'Jobs' },
    { value: 'analytics', label: 'Market' },
]

// The India "new in 24h" number, only when it is already cached (the Market
// tab loaded it). Never fires a request of its own.
function useNewTodayCount() {
    const { data } = useQuery({
        queryKey: ['market-analytics', 'IN'],
        queryFn: () => apiFetch('/api/market/analytics?country=IN'),
        enabled: false,
        staleTime: 10 * 60_000,
    })
    return data?.ready && Number.isFinite(data.new24h) && data.new24h > 0 ? data.new24h : 0
}

export default function JobsPage() {
    const [tab, setTab] = useState('listings')
    const [, setParams] = useSearchParams()
    const newToday = useNewTodayCount()
    // Market -> a top hiring company row: show that company's jobs.
    const showCompany = (name) => {
        setParams((prev) => {
            const next = new URLSearchParams(prev)
            next.set('company', name)
            next.delete('page')
            return next
        })
        setTab('listings')
    }
    return (
        <>
            <Navbar />
            <PageContainer>
                <PageHeader section="jobs" subtitle={newToday ? `${num(newToday)} new jobs today` : undefined} />
                <div style={{ minWidth: 0 }}>
                    <SmallTabs idPrefix="jobs" label="Jobs views" section="jobs" value={tab} onChange={setTab} items={TABS} />
                    <TabPanel idPrefix="jobs" value="listings" active={tab === 'listings'}><ListingsView /></TabPanel>
                    <TabPanel idPrefix="jobs" value="analytics" active={tab === 'analytics'}><MarketAnalytics onCompany={showCompany} /></TabPanel>
                </div>
            </PageContainer>
        </>
    )
}

import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { BarChart3, Briefcase, List, SlidersHorizontal } from 'lucide-react'
import Navbar from '../../components/Navbar'
import { PageContainer, PageHeader } from '../../components/shared/Layout'
import { useJobs, useSearchRequest } from '../../lib/useJobs'
import { apiFetch } from '../../lib/apiClient'
import MarketAnalytics from './MarketAnalytics'
import JobCard, { SEN_LABEL } from './JobCard'
import FacetCombobox from './FacetCombobox'
import { LoadingState, ErrorState, EmptyState } from '../../components/shared/states'
import { LockedSlice } from '../../components/shared/PaywallGate'
import Pagination from '../../components/shared/Pagination'
import { Button, SectionHead, Segmented, Tabs, TabPanel } from '../../components/ui'
import { useAuth } from '../../contexts/AuthContext'

const LOCATION_TYPES = [
    { value: '', label: 'Any' }, { value: 'remote', label: 'Remote', tone: 'success' },
    { value: 'hybrid', label: 'Hybrid', tone: 'active' }, { value: 'onsite', label: 'Onsite', tone: 'history' },
]
const COMPANY_TYPES = [
    { value: '', label: 'All' }, { value: 'product', label: 'Product' },
    { value: 'startup', label: 'Startup' }, { value: 'service', label: 'Service' },
]

// ── Listings tab ───────────────────────────────────────────────────
// Filters live in the URL (?q=&company=&loc=…&page=) so a reload, back
// button or shared link keeps them. Every setter resets the page in the same
// update, so changing a filter never fetches the stale page first.
const FILTER_PARAMS = { search: 'q', company: 'company', locations: 'loc', locationType: 'type', companyType: 'ctype', source: 'source', seniority: 'level', postedWithin: 'posted', sort: 'sort' }

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
    const [moreOpen, setMoreOpen] = useState(false)

    const setFilter = (name) => (value) => {
        setParams((prev) => {
            const next = new URLSearchParams(prev)
            const key = FILTER_PARAMS[name]
            const v = Array.isArray(value) ? value.join(',') : String(value ?? '')
            if (!v || (name === 'sort' && v === 'newest')) next.delete(key)
            else next.set(key, v)
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
    // Secondary filters (collapsed behind "Filters" on phones).
    const moreCount = [locationType, companyType, source, seniority, postedWithin, sort !== 'newest' && sort].filter(Boolean).length

    return (
        <>
            <div className={`pg-filterbar jobs-filters${moreOpen ? ' is-open' : ''}`}>
                <div data-tour="jobs-filters" className="jobs-filters-row">
                    <FacetCombobox field="title" value={search} onChange={setSearch} className="jobs-fc-q"
                        label="Search job title or company" placeholder="Search job title or company…" />
                    <FacetCombobox field="company" value={company} onChange={setCompany} className="jobs-fc-company"
                        label="Company" placeholder="Company" />
                    <FacetCombobox field="location" multiple value={locations} onChange={setLocations} className="jobs-fc-loc"
                        label="Locations" placeholder="Locations" />
                </div>
                <Button className="jobs-filters-toggle" icon={SlidersHorizontal} aria-expanded={moreOpen}
                    aria-controls="jobs-filters-more" onClick={() => setMoreOpen((o) => !o)}>
                    Filters{moreCount ? ` · ${moreCount}` : ''}
                </Button>
                <div id="jobs-filters-more" className="jobs-filters-row jobs-filters-more">
                    <Segmented label="Work type" value={locationType} onChange={setLocationType} options={LOCATION_TYPES} />
                    <Segmented label="Company type" value={companyType} onChange={setCompanyType} options={COMPANY_TYPES} />
                    <select className="sys-select" aria-label="Experience level" value={seniority} onChange={(e) => setSeniority(e.target.value)}>
                        <option value="">Any level</option>
                        {['intern', 'junior', 'mid', 'senior', 'staff', 'principal'].map((s) => (
                            <option key={s} value={s}>{SEN_LABEL[s]}</option>
                        ))}
                    </select>
                    <select className="sys-select" aria-label="Posted within" value={postedWithin} onChange={(e) => setPostedWithin(e.target.value)}>
                        <option value="">Any time</option>
                        <option value="1">Past 24 hours</option>
                    </select>
                    {sourceOptions.length > 1 && (
                        <select className="sys-select" aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)}>
                            {sourceOptions.map((o) => <option key={o.value || 'all'} value={o.value}>{o.label}</option>)}
                        </select>
                    )}
                    <select className="sys-select" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)}>
                        <option value="newest">Latest first</option>
                        <option value="oldest">Oldest first</option>
                        <option value="company">By company</option>
                    </select>
                </div>
            </div>

            {isLoading ? (
                <LoadingState label="Loading jobs…" />
            ) : error ? (
                <ErrorState err={error} onRetry={refetch} />
            ) : data.items.length === 0 ? (
                <EmptyState
                    art="jobs"
                    title={data.notReady ? 'Jobs feed not live yet' : 'No matching jobs'}
                    message={data.notReady
                        ? 'The crawler hasn’t run its first pass yet.'
                        : (anyFilter ? 'Try loosening the filters.' : 'No open postings right now.')}
                />
            ) : (
                <section aria-labelledby="jobs-results-h">
                    <SectionHead
                        id="jobs-results-h"
                        icon={Briefcase}
                        tone="active"
                        title="Open roles"
                        count={data.total}
                        action={<span className="jobs-updating" aria-live="polite">{isFetching ? 'Updating…' : ''}</span>}
                    />
                    <div className={`job-list${isFetching ? ' is-fetching' : ''}`}>
                        {data.items.map((j) => <JobCard key={j.id} j={j} />)}
                    </div>
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
                        accent="var(--sys-active)" label="Job pages" />
                </section>
            )}
        </>
    )
}

// ── page ───────────────────────────────────────────────────────────
const TABS = [
    { value: 'listings', label: 'Listings', icon: List },
    { value: 'analytics', label: 'Analytics', icon: BarChart3 },
]

export default function JobsPage() {
    const [tab, setTab] = useState('listings')
    return (
        <>
            <Navbar />
            <PageContainer>
                <PageHeader
                    title="Jobs"
                    subtitle="Tech roles from ~500 companies, posted in the last 24 hours."
                    actions={<Tabs idPrefix="jobs" label="Jobs views" value={tab} onChange={setTab} items={TABS} />}
                />

                <div style={{ minWidth: 0 }}>
                    <TabPanel idPrefix="jobs" value="listings" active={tab === 'listings'}><ListingsView /></TabPanel>
                    <TabPanel idPrefix="jobs" value="analytics" active={tab === 'analytics'}><MarketAnalytics /></TabPanel>
                </div>
            </PageContainer>
        </>
    )
}

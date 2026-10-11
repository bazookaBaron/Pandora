import { useEffect } from 'react'
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { apiFetch } from './apiClient'
import { consumeInitialData } from './initialData'

// ── Jobs board hooks ───────────────────────────────────────────────
// Reads the crawler-populated job table (see C:\Users\debna\Downloads\job-crawler).
// All access goes through the Express API so the server stays authoritative and
// the DB creds never reach the browser.

const EMPTY = {
    items: [], total: 0, page: 1, pageCount: 1, locked: 0, limit: undefined,
    facets: { sources: [], locationTypes: [], seniorities: [], companyTypes: [], countries: [] },
}

function jobsQueryString(params) {
    const qs = new URLSearchParams()
    if (params.search) qs.set('search', params.search)
    if (params.company) qs.set('company', params.company)
    if (params.location) qs.set('location', params.location)
    if (params.locationType) qs.set('location_type', params.locationType)
    if (params.companyType) qs.set('company_type', params.companyType)
    if (params.source) qs.set('source', params.source)
    if (params.seniority) qs.set('seniority', params.seniority)
    if (params.postedWithin) qs.set('posted_within', params.postedWithin)
    if (params.sort && params.sort !== 'newest') qs.set('sort', params.sort)
    if (params.page && params.page > 1) qs.set('page', String(params.page))
    return qs.toString()
}

export function useJobs(params) {
    const queryClient = useQueryClient()
    const query = useQuery({
        queryKey: ['jobs', params],
        queryFn: () => apiFetch('/api/jobs?' + jobsQueryString(params)),
        placeholderData: keepPreviousData,
        staleTime: 60_000,
    })

    // Warm the next page in the background so "Next" renders from cache.
    const page = params.page || 1
    const hasNext = !query.isPlaceholderData && page < (query.data?.pageCount ?? 1)
    const nextParams = hasNext ? { ...params, page: page + 1 } : null
    const nextKey = nextParams ? JSON.stringify(nextParams) : null
    useEffect(() => {
        if (!nextParams) return
        queryClient.prefetchQuery({
            queryKey: ['jobs', nextParams],
            queryFn: () => apiFetch('/api/jobs?' + jobsQueryString(nextParams)),
            staleTime: 60_000,
        })
        // nextKey captures nextParams by value.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nextKey, queryClient])

    return { ...query, data: query.data || EMPTY }
}

// Result-aware autocomplete: distinct company / location values that exist in
// the current OPEN job set, fuzzy-ranked server-side against `query`.
export function useJobFacet(field, query, enabled = true) {
    const q = (query || '').trim()
    const result = useQuery({
        queryKey: ['jobs-facet', field, q],
        queryFn: () => apiFetch(`/api/jobs/facets?field=${field}&q=${encodeURIComponent(q)}`),
        enabled: !!field && enabled,
        placeholderData: keepPreviousData,
        staleTime: 5 * 60_000,
    })
    return { ...result, options: result.data?.options || [] }
}

const EMPTY_COMPANY = { company: null, postings: [], eligible: false }

// One company's open-postings hub page (/jobs/company/:slug). 404s surface
// through react-query's `error` like any other apiFetch call.
export function useJobsCompany(slug) {
    const query = useQuery({
        queryKey: ['jobs-company', slug],
        queryFn: () => apiFetch(`/api/jobs/company/${encodeURIComponent(slug)}`),
        enabled: !!slug,
        staleTime: 60_000,
        // Server embeds this keyed just by name, not by slug (it only ever
        // renders one company page per request) — guard against a stale
        // seed applying to the WRONG company if the user navigates
        // client-side from one /jobs/company/:slug straight to another
        // without a full page reload in between.
        initialData: () => {
            const seed = consumeInitialData('jobsCompany')
            return seed && seed.company?.slug === slug ? seed : undefined
        },
    })
    return { ...query, data: query.data || EMPTY_COMPANY }
}

const EMPTY_ANALYTICS = {
    total: 0, companiesWithJobs: 0, bySeniority: [], byWorkType: [],
    bySource: [], topCompanies: [], postedByDay: [], midSharePct: null,
}

export function useJobsAnalytics(enabled) {
    const query = useQuery({
        queryKey: ['jobs-analytics'],
        queryFn: () => apiFetch('/api/jobs/analytics'),
        enabled: !!enabled,
        staleTime: 5 * 60_000,
    })
    return { ...query, data: query.data || EMPTY_ANALYTICS }
}

const EMPTY_TREND = { granularity: 'weekly', points: [] }

// Historical hiring-velocity series from the crawler's daily market snapshot
// (public.jobs_market_snapshot_daily), resampled server-side into weekly or
// monthly buckets. Independent of useJobsAnalytics's live RPC — it may have
// data (or not) regardless of whether the live snapshot is ready.
export function useJobsTrend(granularity, enabled) {
    const g = granularity === 'monthly' ? 'monthly' : 'weekly'
    const query = useQuery({
        queryKey: ['jobs-trend', g],
        queryFn: () => apiFetch(`/api/jobs/analytics/trend?granularity=${g}`),
        enabled: !!enabled,
        staleTime: 5 * 60_000,
    })
    return { ...query, data: query.data || EMPTY_TREND }
}

// ── Daily trend reports (/trends, /trends/:date) ───────────────────
export function useTrendsIndex() {
    const query = useQuery({
        queryKey: ['trends-index'],
        queryFn: () => apiFetch('/api/trends'),
        staleTime: 10 * 60_000,
        initialData: () => consumeInitialData('trendsIndex'),
    })
    return { ...query, data: query.data || { days: [] } }
}

export function useTrendsDay(date) {
    return useQuery({
        queryKey: ['trends-day', date],
        queryFn: () => apiFetch(`/api/trends/${encodeURIComponent(date)}`),
        enabled: !!date,
        staleTime: 10 * 60_000,
        // Server seeds one specific day — only use it for that day.
        initialData: () => {
            const seed = consumeInitialData('trendsDay')
            return seed && seed.day?.date === date ? seed : undefined
        },
        retry: (count, err) => (err && err.status === 404 ? false : count < 1),
    })
}

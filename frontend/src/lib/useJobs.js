import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from './apiClient'

// ── Jobs board hooks ───────────────────────────────────────────────
// Reads the crawler-populated job table (see C:\Users\debna\Downloads\job-crawler).
// All access goes through the Express API so the server stays authoritative and
// the DB creds never reach the browser.

const EMPTY = {
    items: [], total: 0, page: 1, pageCount: 1,
    facets: { sources: [], locationTypes: [], seniorities: [] },
}

export function useJobs(params) {
    const { user } = useAuth()
    const qs = new URLSearchParams()
    if (params.search) qs.set('search', params.search)
    if (params.company) qs.set('company', params.company)
    if (params.location) qs.set('location', params.location)
    if (params.locationType) qs.set('location_type', params.locationType)
    if (params.source) qs.set('source', params.source)
    if (params.seniority) qs.set('seniority', params.seniority)
    if (params.postedWithin) qs.set('posted_within', params.postedWithin)
    if (params.sort && params.sort !== 'newest') qs.set('sort', params.sort)
    if (params.page && params.page > 1) qs.set('page', String(params.page))

    const query = useQuery({
        queryKey: ['jobs', params],
        queryFn: () => apiFetch('/api/jobs?' + qs.toString()),
        enabled: !!user,
        placeholderData: keepPreviousData,
        staleTime: 60_000,
    })

    return { ...query, data: query.data || EMPTY }
}

const EMPTY_ANALYTICS = {
    total: 0, companiesWithJobs: 0, bySeniority: [], byWorkType: [],
    bySource: [], topCompanies: [], postedByDay: [], midSharePct: null,
}

export function useJobsAnalytics(enabled) {
    const { user } = useAuth()
    const query = useQuery({
        queryKey: ['jobs-analytics'],
        queryFn: () => apiFetch('/api/jobs/analytics'),
        enabled: !!user && enabled,
        staleTime: 5 * 60_000,
    })
    return { ...query, data: query.data || EMPTY_ANALYTICS }
}

import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from './apiClient'

// ── Jobs board hooks ───────────────────────────────────────────────
// Reads the crawler-populated job table (see C:\Users\debna\Downloads\job-crawler).
// All access goes through the Express API so the server stays authoritative and
// the DB creds never reach the browser.

const EMPTY = { items: [], total: 0, page: 1, pageCount: 1, facets: { sources: [], locationTypes: [] } }

export function useJobs(params) {
    const { user } = useAuth()
    const qs = new URLSearchParams()
    if (params.search) qs.set('search', params.search)
    if (params.company) qs.set('company', params.company)
    if (params.locationType) qs.set('location_type', params.locationType)
    if (params.source) qs.set('source', params.source)
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

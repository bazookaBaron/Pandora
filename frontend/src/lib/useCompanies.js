import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from './apiClient'

// Distinct company names for the filter dropdown. Served by the authenticated
// /api/catalog/companies endpoint (the base catalog tables are not readable by
// the browser's supabase client). Return shape is unchanged: a sorted string[].
export function useCompanies() {
    const { user } = useAuth()
    return useQuery({
        queryKey: ['companies'],
        queryFn: async () => {
            const data = await apiFetch('/api/catalog/companies')
            return data?.companies || []
        },
        enabled: !!user,
        staleTime: 5 * 60 * 1000, // 5 min — company names rarely change
        refetchOnWindowFocus: false,
    })
}

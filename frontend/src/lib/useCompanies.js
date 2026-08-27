import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'

export function useCompanies() {
    return useQuery({
        queryKey: ['companies'],
        queryFn: async () => {
            // Fetch from both tables and merge
            const [lldRes, dsaRes] = await Promise.all([
                supabase.from('lld_problems').select('companies'),
                supabase.from('leetcode_company_problems').select('company'),
            ])

            const set = new Set()
                ; (lldRes.data || []).forEach(r => (r.companies || []).forEach(c => c && set.add(c.trim())))
                ; (dsaRes.data || []).forEach(r => (r.company || []).forEach(c => c && set.add(c.trim())))

            return Array.from(set).sort()
        },
        staleTime: 5 * 60 * 1000, // 5 min — company names rarely change
        refetchOnWindowFocus: false,
    })
}

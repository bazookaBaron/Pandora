import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from './apiClient'

// ── Company-subscription hooks (react-query v5 over the Express API) ──────
// Mirrors src/lib/useReferrals.js's shape. Every read/write goes through
// apiFetch so the server stays authoritative (plan gate, count-cap, ownership).
// No direct supabase here — public.company_subscriptions has no client write
// policies (see sql/18_company_subscriptions.sql).

export function useCompanySubscriptions() {
    const { user } = useAuth()
    return useQuery({
        queryKey: ['company-subscriptions'],
        queryFn: () => apiFetch('/api/company-subscriptions'),
        enabled: !!user,
    })
}

export function useSubscribeToCompany() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: ({ companySlug, companyName }) =>
            apiFetch('/api/company-subscriptions', {
                json: { company_slug: companySlug, company_name: companyName },
            }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['company-subscriptions'] })
        },
    })
}

export function useUnsubscribeFromCompany() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (companySlug) =>
            apiFetch('/api/company-subscriptions/' + encodeURIComponent(companySlug), { method: 'DELETE' }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['company-subscriptions'] })
        },
    })
}

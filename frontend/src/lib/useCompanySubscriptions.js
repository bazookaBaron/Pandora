import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from './apiClient'

// ── Company-subscription hooks (react-query v5 over the Express API) ──────
// Mirrors src/lib/useReferrals.js's shape. Every read/write goes through
// apiFetch so the server stays authoritative (plan gate, count-cap, ownership).
// No direct supabase here — public.company_subscriptions has no client write
// policies (see sql/18_company_subscriptions.sql).

const KEY = ['company-subscriptions']

export function useCompanySubscriptions() {
    const { user } = useAuth()
    return useQuery({
        queryKey: KEY,
        queryFn: () => apiFetch('/api/company-subscriptions'),
        enabled: !!user,
    })
}

// Optimistic toggle — every job card for a subscribed company shares this one
// cached list, so waiting for the POST/DELETE round-trip (plus the refetch it
// used to trigger) before the bell updates reads as a long, laggy delay for
// what should be an instant toggle. Update the cache the moment the click
// happens instead; `onSettled` reconciles with the server after (rolling
// back via the snapshot in `onError` if the write actually failed — e.g. the
// count-cap was hit). The mutation itself is still fully awaited internally
// for that error path — this isn't "skip the request," it's "don't make the
// UI wait on it."

export function useSubscribeToCompany() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: ({ companySlug, companyName }) =>
            apiFetch('/api/company-subscriptions', {
                json: { company_slug: companySlug, company_name: companyName },
            }),
        onMutate: async ({ companySlug, companyName }) => {
            await qc.cancelQueries({ queryKey: KEY })
            const previous = qc.getQueryData(KEY)
            qc.setQueryData(KEY, (old) => {
                if (!old) return old
                if (old.subscriptions.some((s) => s.company_slug === companySlug)) return old
                return {
                    ...old,
                    used: old.used + 1,
                    subscriptions: [
                        { id: `optimistic-${companySlug}`, company_slug: companySlug, company_name: companyName, created_at: new Date().toISOString() },
                        ...old.subscriptions,
                    ],
                }
            })
            return { previous }
        },
        onError: (_err, _vars, context) => {
            if (context?.previous) qc.setQueryData(KEY, context.previous)
        },
        onSettled: () => {
            qc.invalidateQueries({ queryKey: KEY })
        },
    })
}

export function useUnsubscribeFromCompany() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (companySlug) =>
            apiFetch('/api/company-subscriptions/' + encodeURIComponent(companySlug), { method: 'DELETE' }),
        onMutate: async (companySlug) => {
            await qc.cancelQueries({ queryKey: KEY })
            const previous = qc.getQueryData(KEY)
            qc.setQueryData(KEY, (old) => {
                if (!old) return old
                return {
                    ...old,
                    used: Math.max(0, old.used - 1),
                    subscriptions: old.subscriptions.filter((s) => s.company_slug !== companySlug),
                }
            })
            return { previous }
        },
        onError: (_err, _vars, context) => {
            if (context?.previous) qc.setQueryData(KEY, context.previous)
        },
        onSettled: () => {
            qc.invalidateQueries({ queryKey: KEY })
        },
    })
}

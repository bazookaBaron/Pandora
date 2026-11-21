import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from './apiClient'

// ── Referral hooks (react-query v5 over the Express API) ─────────────
// Every read/write goes through apiFetch so the server stays authoritative
// (quota, ownership, company match, signed-URL TTL). No direct supabase here.

export function useMyReferrals() {
    const { user } = useAuth()
    return useQuery({
        queryKey: ['referrals-mine'],
        queryFn: () => apiFetch('/api/referrals/mine'),
        enabled: !!user,
    })
}

export function useOpenReferrals() {
    const { user } = useAuth()
    return useQuery({
        queryKey: ['referrals-open'],
        queryFn: () => apiFetch('/api/referrals/open'),
        enabled: !!user,
    })
}

export function useCompanyOptions(q) {
    const { user } = useAuth()
    return useQuery({
        queryKey: ['profile-companies', q],
        queryFn: () => apiFetch('/api/profiles/companies?q=' + encodeURIComponent(q || '')),
        enabled: !!user,
        staleTime: 5 * 60_000,
    })
}

export function usePostReferral() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (formData) => apiFetch('/api/referrals', { formData }),
        // the form renders its own error text (usage limit, validation)
        meta: { success: 'Referral request posted.', inlineError: true },
        onSuccess: () => qc.invalidateQueries({ queryKey: ['referrals-mine'] }),
    })
}

export function useAcceptReferral() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (id) => apiFetch('/api/referrals/' + id + '/accept', { method: 'POST' }),
        meta: { success: 'Accepted. The candidate has your contact info.', inlineError: true },
        onSuccess: () => Promise.all([
            qc.invalidateQueries({ queryKey: ['referrals-open'] }),
            qc.invalidateQueries({ queryKey: ['referrals-mine'] }),
        ]),
    })
}

export function useCancelReferral() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (id) => apiFetch('/api/referrals/' + id + '/cancel', { method: 'POST' }),
        meta: { success: 'Request cancelled.', inlineError: true },
        // optimistic: the card shows "cancelled" at once; rolled back on error
        onMutate: async (id) => {
            await qc.cancelQueries({ queryKey: ['referrals-mine'] })
            const previous = qc.getQueryData(['referrals-mine'])
            qc.setQueryData(['referrals-mine'], (old) =>
                old && Array.isArray(old.requests)
                    ? { ...old, requests: old.requests.map((r) => (r.id === id ? { ...r, status: 'cancelled' } : r)) }
                    : old,
            )
            return { previous }
        },
        onError: (_e, _id, ctx) => {
            if (ctx?.previous !== undefined) qc.setQueryData(['referrals-mine'], ctx.previous)
        },
        onSuccess: () => Promise.all([
            qc.invalidateQueries({ queryKey: ['referrals-open'] }),
            qc.invalidateQueries({ queryKey: ['referrals-mine'] }),
        ]),
    })
}

// Open a request's resume. The tab is opened synchronously inside the click
// (popup blockers only allow window.open in the user gesture), then pointed
// at the short-lived signed URL once it arrives. The URL is never returned
// to callers or stored.
export async function fetchResumeUrl(id) {
    const w = window.open('', '_blank')
    try {
        const { url } = await apiFetch('/api/referrals/' + id + '/resume')
        if (!url) throw new Error('No resume on file for this request.')
        if (w) {
            w.opener = null
            w.location.href = url
        } else {
            window.location.assign(url)
        }
    } catch (err) {
        if (w) w.close()
        throw err
    }
}

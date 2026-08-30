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
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['referrals-mine'] })
        },
    })
}

export function useAcceptReferral() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (id) => apiFetch('/api/referrals/' + id + '/accept', { method: 'POST' }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['referrals-open'] })
            qc.invalidateQueries({ queryKey: ['referrals-mine'] })
        },
    })
}

export function useCancelReferral() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (id) => apiFetch('/api/referrals/' + id + '/cancel', { method: 'POST' }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['referrals-open'] })
            qc.invalidateQueries({ queryKey: ['referrals-mine'] })
        },
    })
}

// Fetch a short-lived signed URL for a request's resume and open it in a new
// tab. The URL is never returned to callers or stored — it lives only for the
// window.open call.
export async function fetchResumeUrl(id) {
    const { url } = await apiFetch('/api/referrals/' + id + '/resume')
    if (url) window.open(url, '_blank', 'noopener')
}

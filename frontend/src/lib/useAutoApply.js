import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import { ApiError, apiFetch } from './apiClient'
import { supabase } from './supabase'

// ── AutoApply API hooks ─────────────────────────────────────────────
// One react-query hook per endpoint in docs/autoapply-contract.md.
// AutoApply errors are `{error: {code, message}}` (an object), while the
// shared apiFetch expects `{error: '<code>'}` — `aa()` normalises the thrown
// ApiError so `err.code` is always the string code and `err.message` the
// server's human message.

const BASE = '/api/autoapply'

async function aa(path, opts) {
    try {
        return await apiFetch(BASE + path, opts)
    } catch (err) {
        if (err instanceof ApiError && err.body && typeof err.body.error === 'object' && err.body.error) {
            const { code, message } = err.body.error
            const e = new ApiError(message || code || `Request failed (${err.status})`, {
                status: err.status, code: code || null, body: err.body,
            })
            throw e
        }
        throw err
    }
}

export const aaKeys = {
    all: ['aa'],
    me: ['aa', 'me'],
    answers: ['aa', 'answers'],
    supply: (kind, windowDays) => ['aa', 'supply', kind, windowDays],
    batches: ['aa', 'batches'],
    batch: (id) => ['aa', 'batch', id],
    needsYou: ['aa', 'needs-you'],
    inbox: (limit) => ['aa', 'inbox', limit],
    accounts: ['aa', 'accounts'],
}

function useUid() {
    const { user } = useAuth()
    return user?.id ?? null
}

// ── reads ──────────────────────────────────────────────────────────
export function useAutoApplyMe() {
    const uid = useUid()
    return useQuery({
        queryKey: [...aaKeys.me, uid],
        queryFn: () => aa('/me'),
        enabled: !!uid,
        staleTime: 30_000,
    })
}

export function useAnswers() {
    const uid = useUid()
    return useQuery({ queryKey: [...aaKeys.answers, uid], queryFn: () => aa('/answers'), enabled: !!uid })
}

export function useSupply(kind, windowDays) {
    const uid = useUid()
    return useQuery({
        queryKey: [...aaKeys.supply(kind, windowDays), uid],
        queryFn: () => aa(`/supply?kind=${encodeURIComponent(kind)}&window_days=${Number(windowDays)}`),
        enabled: !!uid && !!kind && windowDays >= 1 && windowDays <= 30,
        staleTime: 60_000,
        placeholderData: (prev) => prev,
    })
}

export function useBatches({ live = false } = {}) {
    const uid = useUid()
    return useQuery({
        queryKey: [...aaKeys.batches, uid],
        queryFn: () => aa('/batches'),
        enabled: !!uid,
        staleTime: 10_000,
        refetchInterval: live ? false : 15_000,
    })
}

export function useBatch(id, { live = false } = {}) {
    const uid = useUid()
    return useQuery({
        queryKey: [...aaKeys.batch(id), uid],
        queryFn: () => aa(`/batches/${encodeURIComponent(id)}`),
        enabled: !!uid && !!id,
        staleTime: 5_000,
        refetchInterval: live ? false : 15_000,
    })
}

export function useNeedsYou() {
    const uid = useUid()
    return useQuery({
        queryKey: [...aaKeys.needsYou, uid],
        queryFn: () => aa('/needs-you'),
        enabled: !!uid,
        refetchInterval: 30_000,
    })
}

export function useInbox(limit = 50, { refetchInterval = 30_000 } = {}) {
    const uid = useUid()
    return useQuery({
        queryKey: [...aaKeys.inbox(limit), uid],
        queryFn: () => aa(`/inbox?limit=${Number(limit)}`),
        enabled: !!uid,
        refetchInterval,
    })
}

export function useAccounts() {
    const uid = useUid()
    return useQuery({ queryKey: [...aaKeys.accounts, uid], queryFn: () => aa('/accounts'), enabled: !!uid })
}

// ── writes ─────────────────────────────────────────────────────────
export function useSaveProfile() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (body) => aa('/profile', { method: 'PUT', json: body }),
        onSuccess: () => qc.invalidateQueries({ queryKey: aaKeys.me }),
    })
}

export function useUploadResume() {
    return useMutation({
        mutationFn: (file) => {
            const fd = new FormData()
            fd.append('resume', file)
            return aa('/resume', { method: 'POST', formData: fd })
        },
    })
}

export function useSaveAnswers() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (answers) => aa('/answers', { method: 'PUT', json: { answers } }),
        onSuccess: () => qc.invalidateQueries({ queryKey: aaKeys.answers }),
    })
}

export function useCreateOrder() {
    return useMutation({ mutationFn: (body) => aa('/orders', { json: body }) })
}

export function useVerifyOrder() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (body) => aa('/orders/verify', { json: body }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: aaKeys.batches })
            qc.invalidateQueries({ queryKey: aaKeys.me })
        },
    })
}

// action: 'approve' | 'pause' | 'resume' | 'cancel'
export function useBatchAction() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: ({ id, action }) => aa(`/batches/${encodeURIComponent(id)}/${action}`, { method: 'POST' }),
        onSuccess: (_d, { id }) => {
            qc.invalidateQueries({ queryKey: aaKeys.batch(id) })
            qc.invalidateQueries({ queryKey: aaKeys.batches })
            qc.invalidateQueries({ queryKey: aaKeys.me })
        },
    })
}

export function useRemoveTask() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: ({ batchId, taskId }) =>
            aa(`/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskId)}/remove`, { method: 'POST' }),
        onSuccess: (_d, { batchId }) => qc.invalidateQueries({ queryKey: aaKeys.batch(batchId) }),
    })
}

// action: 'done' | 'answer' | 'dismiss'
export function useResolveNeedsYou() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: ({ id, action, answer }) =>
            aa(`/needs-you/${encodeURIComponent(id)}`, { json: answer !== undefined ? { action, answer } : { action } }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: aaKeys.needsYou })
            qc.invalidateQueries({ queryKey: ['aa', 'batch'] })
        },
    })
}

export function useRevealPassword() {
    return useMutation({ mutationFn: (tenant_host) => aa('/accounts/reveal', { json: { tenant_host } }) })
}

// ── live updates ───────────────────────────────────────────────────
// Supabase Realtime postgres_changes on aa_tasks + aa_batches filtered by the
// user. Any change invalidates the batch queries. Returns `live` = true while
// the channel is SUBSCRIBED; callers pass it to useBatches/useBatch so the
// 15 s polling fallback only runs when realtime is down.
export function useAutoApplyRealtime() {
    const uid = useUid()
    const qc = useQueryClient()
    const [live, setLive] = useState(false)

    useEffect(() => {
        if (!uid) return undefined
        let channel
        try {
            const filter = `user_id=eq.${uid}`
            const bump = (payload) => {
                const row = payload?.new || payload?.old || {}
                qc.invalidateQueries({ queryKey: aaKeys.batches })
                const batchId = payload?.table === 'aa_batches' ? row.id : row.batch_id
                if (batchId) qc.invalidateQueries({ queryKey: aaKeys.batch(batchId) })
                else qc.invalidateQueries({ queryKey: ['aa', 'batch'] })
                if (row.status === 'needs_you') qc.invalidateQueries({ queryKey: aaKeys.needsYou })
            }
            channel = supabase
                .channel(`aa-live-${uid}`)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'aa_tasks', filter }, bump)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'aa_batches', filter }, bump)
                .subscribe((status) => setLive(status === 'SUBSCRIBED'))
        } catch {
            setLive(false)
        }
        return () => {
            setLive(false)
            if (channel) supabase.removeChannel(channel)
        }
    }, [uid, qc])

    return live
}

import { useEffect, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import { ApiError, UPLOAD_TIMEOUT_MS, apiFetch } from './apiClient'
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
    wallet: ['aa', 'wallet'],
    batches: ['aa', 'batches'],
    batch: (id) => ['aa', 'batch', id],
    needsYou: ['aa', 'needs-you'],
    inbox: (tab, q, limit) => ['aa', 'inbox', tab, q, limit],
    inboxMail: (id) => ['aa', 'inbox-mail', id],
    inboxUnread: ['aa', 'inbox-unread'],
    inboxCompanies: ['aa', 'inbox-companies'],
    interviews: ['aa', 'interviews'],
    accounts: ['aa', 'accounts'],
    replyStats: ['aa', 'stats', 'replies'],
    adminHealth: ['aa', 'admin', 'health'],
    companySuggest: (q, kind) => ['aa', 'company-suggest', q, kind],
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

export function useSupply(kind, windowDays, pack = 50) {
    const uid = useUid()
    return useQuery({
        queryKey: [...aaKeys.supply(kind, windowDays), pack, uid],
        queryFn: () => aa(`/supply?kind=${encodeURIComponent(kind)}&window_days=${Number(windowDays)}&pack=${Number(pack)}`),
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

// One options object for every observer of ['aa','needs-you',uid]: two hooks used to register the same
// key with different refetchIntervals (30 s vs 60 s), so the shortest won and the options fought.
const needsYouQuery = (uid, enabled) => ({
    queryKey: [...aaKeys.needsYou, uid],
    queryFn: () => aa('/needs-you'),
    enabled: !!uid && enabled,
    refetchInterval: 30_000,
    staleTime: 20_000,
})

export function useNeedsYou({ enabled = true } = {}) {
    const uid = useUid()
    return useQuery(needsYouQuery(uid, enabled))
}

/**
 * "Answers needed" count for the bottom-nav badge. Shares the ['aa','needs-you',uid] cache with
 * useNeedsYou (no second copy of the list). Only users who finished Auto Apply setup can have a pack,
 * so /needs-you is fetched for them only; everyone else costs just the (cached, 30 s stale) /me read.
 * Pass { enabled: false } to read the cache only. Returns a number (0 while loading / signed out).
 */
export function useAnswersNeededCount({ enabled = true } = {}) {
    const uid = useUid()
    const me = useQuery({
        queryKey: [...aaKeys.me, uid],
        queryFn: () => aa('/me'),
        enabled: !!uid && enabled,
        staleTime: 5 * 60_000,
    })
    const onboarded = !!me.data?.onboarding_done
    const q = useQuery(needsYouQuery(uid, enabled && onboarded))
    return uid && Array.isArray(q.data?.items) ? q.data.items.length : 0
}

/**
 * Inbox list, newest first, paginated with ?before=. tab: 'important' | 'all' | 'codes'; filters (all optional):
 * category ('code'|'received'|'rejected'|'important'|'other'), kind ('interview'|'assessment'|'offer'|'recruiter'|'rejection'),
 * company (text), unread (bool), q (search sender / subject / text).
 */
export function useInbox({ tab = 'all', q = '', category = '', kind = '', company = '', unread = false, limit = 30, refetchInterval = 30_000 } = {}) {
    const uid = useUid()
    const filters = { tab, q, category, kind, company, unread: unread ? '1' : '' }
    return useInfiniteQuery({
        queryKey: [...aaKeys.inbox(tab, q, limit), category, kind, company, !!unread, uid],
        queryFn: ({ pageParam }) => {
            const p = new URLSearchParams({ limit: String(limit) })
            for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v)
            if (pageParam) p.set('before', pageParam)
            return aa('/inbox?' + p.toString())
        },
        initialPageParam: null,
        getNextPageParam: (last) => last?.next_before || undefined,
        enabled: !!uid,
        refetchInterval,
    })
}

/** Opening a mail marks it read on the server; the list row and unread badge are patched once it loads. */
export function useInboxMail(id) {
    const uid = useUid()
    const qc = useQueryClient()
    const q = useQuery({
        queryKey: [...aaKeys.inboxMail(id), uid],
        queryFn: () => aa('/inbox/' + encodeURIComponent(id)),
        enabled: !!uid && !!id,
    })
    const mail = q.data && q.data.mail
    const readAt = mail && mail.read_at
    useEffect(() => {
        if (!mail || !readAt) return

        qc.setQueriesData({ queryKey: ['aa', 'inbox'] }, (old) => {
            if (!old || !Array.isArray(old.pages)) return old
            return {
                ...old,
                pages: old.pages.map((pg) => {
                    if (!pg || !Array.isArray(pg.mails)) return pg
                    return {
                        ...pg,
                        mails: pg.mails.map((m) => {
                            if (m.id !== mail.id || m.read_at) return m

                            return { ...m, read_at: readAt }
                        }),
                    }
                }),
            }
        })
        qc.invalidateQueries({ queryKey: aaKeys.inboxUnread })
    }, [qc, mail, readAt])
    return q
}

/** { count, by_kind } of unread interview / assessment / offer / rejection / important mail (nav badge). */
export function useInboxUnread({ enabled = true } = {}) {
    const uid = useUid()
    return useQuery({
        queryKey: [...aaKeys.inboxUnread, uid],
        queryFn: () => aa('/inbox/unread'),
        enabled: !!uid && enabled,
        refetchInterval: 60_000,
        staleTime: 20_000,
    })
}

export function useInboxCompanies() {
    const uid = useUid()
    return useQuery({ queryKey: [...aaKeys.inboxCompanies, uid], queryFn: () => aa('/inbox/companies'), enabled: !!uid, staleTime: 60_000 })
}

export function useMarkAllRead({ meta: metaOverride } = {}) {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: () => aa('/inbox/read-all', { method: 'POST' }),
        meta: { success: 'All mail marked as read.', ...metaOverride },
        onMutate: async () => {
            await qc.cancelQueries({ queryKey: ['aa', 'inbox'] })
            await qc.cancelQueries({ queryKey: aaKeys.inboxUnread })
            const snap = [...qc.getQueriesData({ queryKey: ['aa', 'inbox'] }), ...qc.getQueriesData({ queryKey: aaKeys.inboxUnread })]
            const at = new Date().toISOString()
            qc.setQueriesData({ queryKey: ['aa', 'inbox'] }, (old) =>
                old && Array.isArray(old.pages)
                    ? { ...old, pages: old.pages.map((pg) => (pg && Array.isArray(pg.mails) ? { ...pg, mails: pg.mails.map((m) => (m.read_at ? m : { ...m, read_at: at })) } : pg)) }
                    : old,
            )
            qc.setQueriesData({ queryKey: aaKeys.inboxUnread }, (old) => (old ? { ...old, count: 0, by_kind: {} } : old))
            return { snap }
        },
        onError: (_e, _v, ctx) => { for (const [k, d] of ctx?.snap || []) qc.setQueryData(k, d) },
        onSuccess: () => Promise.all([
            qc.invalidateQueries({ queryKey: aaKeys.inboxUnread }),
            qc.invalidateQueries({ queryKey: ['aa', 'inbox'] }),
        ]),
    })
}

export function useInterviews() {
    const uid = useUid()
    return useQuery({ queryKey: [...aaKeys.interviews, uid], queryFn: () => aa('/interviews'), enabled: !!uid, refetchInterval: 120_000 })
}

/** Reply rates (last 90 days) per company and per role family. */
export function useReplyStats() {
    const uid = useUid()
    return useQuery({ queryKey: [...aaKeys.replyStats, uid], queryFn: () => aa('/stats/replies'), enabled: !!uid, staleTime: 5 * 60_000 })
}

/** Admin only: aa_health heartbeats. */
export function useAdminHealth({ enabled = true } = {}) {
    const uid = useUid()
    return useQuery({
        queryKey: [...aaKeys.adminHealth, uid],
        queryFn: () => aa('/admin/health'),
        enabled: !!uid && enabled,
        refetchInterval: 30_000,
        retry: (n, err) => err?.status !== 403 && n < 2,
    })
}

/** Company names from open jobs for the must-apply autocomplete (q >= 2 chars). */
export function useCompanySuggest(q, kind) {
    const uid = useUid()
    const term = String(q || '').trim()
    return useQuery({
        queryKey: [...aaKeys.companySuggest(term.toLowerCase(), kind || ''), uid],
        queryFn: () => aa(`/companies/suggest?q=${encodeURIComponent(term)}${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`),
        enabled: !!uid && term.length >= 2,
        staleTime: 5 * 60_000,
        placeholderData: (prev) => prev,
    })
}

/** A 5-minute signed URL for the proof screenshot of one applied task. */
export const fetchTaskProof = (batchId, taskId) =>
    aa(`/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskId)}/proof`)

// Web push endpoints (see usePush.js)
// The VAPID key never changes within a session: fetch it once and share the
// promise (a failure clears it so the next call retries).
let pushKeyPromise = null
export const fetchPushKey = () => {
    if (!pushKeyPromise) {
        pushKeyPromise = aa('/push/key').catch((err) => {
            pushKeyPromise = null
            throw err
        })
    }
    return pushKeyPromise
}
export const pushSubscribe = (sub) => aa('/push/subscribe', { method: 'POST', json: sub })
export const pushUnsubscribe = (endpoint) => aa('/push/unsubscribe', { method: 'POST', json: { endpoint } })

export function useAccounts() {
    const uid = useUid()
    return useQuery({ queryKey: [...aaKeys.accounts, uid], queryFn: () => aa('/accounts'), enabled: !!uid })
}

// ── writes ─────────────────────────────────────────────────────────
// Every write patches the cache from the server's response (or optimistically
// in onMutate, rolled back on error) so the button state flips at once, then
// returns the invalidate promise so isPending lasts until data is fresh.
// Errors toast globally (lib/mutationCache.js); meta.success adds a toast.

// /me shape from a PUT /profile row ({ ok, profile: <aa_profiles row> })
function mePatchFromRow(row) {
    if (!row || typeof row !== 'object') return {}
    const patch = {}
    if (row.profile !== undefined) patch.profile = row.profile || {}
    if (row.prefs !== undefined) patch.prefs = row.prefs || {}
    if (row.resume_path !== undefined) patch.resume_path = row.resume_path || null
    if (row.consent_at !== undefined) patch.consent_at = row.consent_at || null
    if (row.onboarding_done !== undefined) patch.onboarding_done = !!row.onboarding_done
    if (row.review_before_apply !== undefined) patch.review_before_apply = row.review_before_apply !== false
    if (row.alert_prefs) patch.alert_prefs = row.alert_prefs
    return patch
}

function patchMe(qc, patch, emailPatch) {
    qc.setQueriesData({ queryKey: aaKeys.me }, (old) => {
        if (!old) return old
        const next = { ...old, ...patch }
        if (emailPatch) next.email = { ...(old.email || {}), ...emailPatch }
        return next
    })
}

// Merge a returned batch row into the detail cache and the batches list.
function patchBatch(qc, batch) {
    if (!batch || !batch.id) return
    qc.setQueriesData({ queryKey: aaKeys.batch(batch.id) }, (old) => (old ? { ...old, batch: { ...old.batch, ...batch } } : old))
    qc.setQueriesData({ queryKey: aaKeys.batches }, (old) =>
        old && Array.isArray(old.batches)
            ? { ...old, batches: old.batches.map((b) => (b.id === batch.id ? { ...b, ...batch } : b)) }
            : old,
    )
}

const snapshot = (qc, queryKey) => qc.getQueriesData({ queryKey })
function restore(qc, snap) {
    for (const [key, data] of snap || []) qc.setQueryData(key, data)
}

export function useSaveProfile({ meta } = {}) {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (body) => aa('/profile', { method: 'PUT', json: body }),
        meta,
        onSuccess: (d, body) => {
            const row = d && d.profile
            const emailPatch = {}
            const src = row || body || {}
            if (src.email_mode !== undefined) emailPatch.mode = src.email_mode || 'inbox'
            if (src.contact_email !== undefined) emailPatch.contact_email = src.contact_email
            if (row && row.apply_alias) emailPatch.alias = row.apply_alias
            patchMe(qc, mePatchFromRow(src), Object.keys(emailPatch).length ? emailPatch : null)
            return qc.invalidateQueries({ queryKey: aaKeys.me })
        },
    })
}

export function useUploadResume({ meta } = {}) {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (file) => {
            const fd = new FormData()
            fd.append('resume', file)
            return aa('/resume', { method: 'POST', formData: fd, timeout: UPLOAD_TIMEOUT_MS })
        },
        meta: { success: 'Resume uploaded.', ...meta },
        onSuccess: (d) => {
            if (d && d.resume_path) patchMe(qc, { resume_path: d.resume_path })
            return qc.invalidateQueries({ queryKey: aaKeys.me })
        },
    })
}

export function useSaveAnswers({ meta } = {}) {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (answers) => aa('/answers', { method: 'PUT', json: { answers } }),
        meta,
        onSuccess: (d) => {
            if (d && d.answers) qc.setQueriesData({ queryKey: aaKeys.answers }, (old) => ({ ...(old || {}), ...d }))
            // readiness / profile_check on /me depend on the answers
            return Promise.all([
                qc.invalidateQueries({ queryKey: aaKeys.answers }),
                qc.invalidateQueries({ queryKey: aaKeys.me }),
            ])
        },
    })
}

/** Wallet balance + reserved amount + rates (GET /wallet). Refreshed often: the worker charges as it applies. */
export function useWallet() {
    const uid = useUid()
    return useQuery({
        queryKey: [...aaKeys.wallet, uid],
        queryFn: () => aa('/wallet'),
        enabled: !!uid,
        staleTime: 10_000,
        refetchInterval: 20_000,
    })
}

export function useTopupOrder() {
    return useMutation({ mutationFn: (amount_paise) => aa('/wallet/topup', { json: { amount_paise } }), meta: { inlineError: true } })
}

export function useVerifyTopup() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (body) => aa('/wallet/topup/verify', { json: body, timeout: 60_000 }),
        meta: { inlineError: true },
        // a top-up resumes batches that waited for funds: refresh everything that shows money or batch state
        onSuccess: () => Promise.all([
            qc.invalidateQueries({ queryKey: aaKeys.wallet }),
            qc.invalidateQueries({ queryKey: aaKeys.batches }),
            qc.invalidateQueries({ queryKey: ['aa', 'batch'] }),
        ]),
    })
}

/** POST /batches: start a batch from the wallet. */
export function useStartBatch() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (body) => aa('/batches', { json: body }),
        meta: { inlineError: true },
        onSuccess: () => Promise.all([
            qc.invalidateQueries({ queryKey: aaKeys.wallet }),
            qc.invalidateQueries({ queryKey: aaKeys.batches }),
            qc.invalidateQueries({ queryKey: aaKeys.me }),
        ]),
    })
}

export function useCreateOrder() {
    // BuyPage renders order errors inline
    return useMutation({ mutationFn: (body) => aa('/orders', { json: body }), meta: { inlineError: true } })
}

export function useCouponQuote() {
    return useMutation({ mutationFn: (body) => aa('/orders/coupon', { json: body }), meta: { inlineError: true } })
}

export function useVerifyOrder() {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (body) => aa('/orders/verify', { json: body, timeout: 60_000 }),
        meta: { inlineError: true },
        onSuccess: (d) => {
            if (d && d.batch && d.batch.id) {
                qc.setQueriesData({ queryKey: aaKeys.batches }, (old) =>
                    old && Array.isArray(old.batches) && !old.batches.some((b) => b.id === d.batch.id)
                        ? { ...old, batches: [d.batch, ...old.batches] }
                        : old,
                )
            }
            return Promise.all([
                qc.invalidateQueries({ queryKey: aaKeys.batches }),
                qc.invalidateQueries({ queryKey: aaKeys.me }),
            ])
        },
    })
}

export function useSetMustCompanies({ meta: metaOverride } = {}) {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: ({ id, companies }) => aa(`/batches/${encodeURIComponent(id)}/must-companies`, { method: 'PUT', json: { must_companies: companies } }),
        meta: { success: 'Must-apply companies saved.', ...metaOverride },
        onMutate: async ({ id, companies }) => {
            await qc.cancelQueries({ queryKey: aaKeys.batch(id) })
            const snap = snapshot(qc, aaKeys.batch(id))
            qc.setQueriesData({ queryKey: aaKeys.batch(id) }, (old) =>
                old ? { ...old, batch: { ...old.batch, must_companies: companies } } : old,
            )
            return { snap }
        },
        onError: (_e, _v, ctx) => restore(qc, ctx?.snap),
        onSuccess: (d, { id }) => {
            if (d && d.batch) patchBatch(qc, d.batch)
            return Promise.all([
                qc.invalidateQueries({ queryKey: aaKeys.batch(id) }),
                qc.invalidateQueries({ queryKey: aaKeys.batches }),
            ])
        },
    })
}

// Optimistic status guess only; the server's { batch } replaces it.
const OPTIMISTIC_STATUS = { pause: 'paused', cancel: 'cancelled' }
const ACTION_DONE = {
    approve: 'Approved. We start applying shortly.',
    pause: 'Batch paused.',
    resume: 'Batch resumed.',
    cancel: 'Batch stopped. Unused money stays in your wallet.',
}

// action: 'approve' | 'pause' | 'resume' | 'cancel'
export function useBatchAction({ meta: metaOverride } = {}) {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: ({ id, action }) => aa(`/batches/${encodeURIComponent(id)}/${action}`, { method: 'POST' }),
        meta: { success: (_d, { action }) => ACTION_DONE[action] || 'Done.', ...metaOverride },
        onMutate: async ({ id, action }) => {
            const status = OPTIMISTIC_STATUS[action]
            if (!status) return {}
            await qc.cancelQueries({ queryKey: aaKeys.batch(id) })
            const snap = [...snapshot(qc, aaKeys.batch(id)), ...snapshot(qc, aaKeys.batches)]
            patchBatch(qc, { id, status })
            return { snap }
        },
        onError: (_e, _v, ctx) => restore(qc, ctx?.snap),
        onSuccess: (d, { id }) => {
            if (d && d.batch) patchBatch(qc, d.batch)
            return Promise.all([
                qc.invalidateQueries({ queryKey: aaKeys.batch(id) }),
                qc.invalidateQueries({ queryKey: aaKeys.batches }),
                qc.invalidateQueries({ queryKey: aaKeys.me }),
            ])
        },
    })
}

export function useRemoveTask({ meta: metaOverride } = {}) {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: ({ batchId, taskId }) =>
            aa(`/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskId)}/remove`, { method: 'POST' }),
        meta: { success: 'Job removed from this pack.', ...metaOverride },
        onMutate: async ({ batchId, taskId }) => {
            await qc.cancelQueries({ queryKey: aaKeys.batch(batchId) })
            const snap = snapshot(qc, aaKeys.batch(batchId))
            qc.setQueriesData({ queryKey: aaKeys.batch(batchId) }, (old) => {
                if (!old || !Array.isArray(old.tasks)) return old
                const prev = old.tasks.find((t) => t.id === taskId)
                if (!prev || prev.status === 'removed') return old
                const counts = { ...(old.counts || {}) }
                counts[prev.status] = Math.max(0, (counts[prev.status] || 0) - 1)
                counts.removed = (counts.removed || 0) + 1
                return {
                    ...old,
                    counts,
                    tasks: old.tasks.map((t) => (t.id === taskId ? { ...t, status: 'removed', reason_code: 'removed_by_user' } : t)),
                }
            })
            return { snap }
        },
        onError: (_e, _v, ctx) => restore(qc, ctx?.snap),
        onSuccess: (d, { batchId, taskId }) => {
            if (d && d.task) {
                qc.setQueriesData({ queryKey: aaKeys.batch(batchId) }, (old) =>
                    old && Array.isArray(old.tasks)
                        ? { ...old, tasks: old.tasks.map((t) => (t.id === taskId ? { ...t, ...d.task } : t)) }
                        : old,
                )
            }
            return qc.invalidateQueries({ queryKey: aaKeys.batch(batchId) })
        },
    })
}

const NEEDS_DONE = {
    done: 'Marked as done.',
    answer: 'Answer saved. We will retry this job.',
    dismiss: 'Dismissed.',
    confirm_submitted: 'Recorded as applied.',
    not_submitted: 'Thanks. We will try this job again if your pack still has credits.',
}

// action: 'done' | 'answer' | 'dismiss' | 'confirm_submitted' | 'not_submitted' (the last two only for
// verify_submission items: "did this application go through?")
export function useResolveNeedsYou({ meta: metaOverride } = {}) {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: ({ id, action, answer }) =>
            aa(`/needs-you/${encodeURIComponent(id)}`, { json: answer !== undefined ? { action, answer } : { action } }),
        meta: { success: (_d, { action }) => NEEDS_DONE[action] || 'Done.', ...metaOverride },
        onMutate: async ({ id }) => {
            await qc.cancelQueries({ queryKey: aaKeys.needsYou })
            const snap = snapshot(qc, aaKeys.needsYou)
            qc.setQueriesData({ queryKey: aaKeys.needsYou }, (old) =>
                old && Array.isArray(old.items) ? { ...old, items: old.items.filter((i) => i.id !== id) } : old,
            )
            return { snap }
        },
        onError: (_e, _v, ctx) => restore(qc, ctx?.snap),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['aa', 'batch'] })
            qc.invalidateQueries({ queryKey: aaKeys.me })
            return qc.invalidateQueries({ queryKey: aaKeys.needsYou })
        },
    })
}

export function useRevealPassword() {
    return useMutation({ mutationFn: (tenant_host) => aa('/accounts/reveal', { json: { tenant_host } }), meta: { inlineError: true } })
}

// ── live updates ───────────────────────────────────────────────────
// Supabase Realtime postgres_changes on aa_tasks + aa_batches filtered by the
// user. Each event patches the changed row straight into the cache (so the
// table updates instantly) and schedules a throttled refetch (at most one per
// key every ~2 s) for derived data like counts and charge. A running batch can
// emit dozens of task events a second; refetching the whole batch on every
// one hammered the API and made rows flicker. Returns `live` = true while the
// channel is SUBSCRIBED; callers pass it to useBatches/useBatch so the 15 s
// polling fallback only runs when realtime is down.
const REALTIME_REFETCH_MS = 2000

// Fields the realtime row may carry that are safe to merge into a public task.
const TASK_LIVE_FIELDS = ['status', 'reason_code', 'reason_detail', 'submitted_at', 'not_before', 'attempts', 'updated_at', 'score']

export function useAutoApplyRealtime() {
    const uid = useUid()
    const qc = useQueryClient()
    const [live, setLive] = useState(false)

    useEffect(() => {
        if (!uid) return undefined
        let channel
        const timers = new Map()
        const refetchSoon = (queryKey) => {
            const k = JSON.stringify(queryKey)
            if (timers.has(k)) return
            timers.set(k, setTimeout(() => {
                timers.delete(k)
                qc.invalidateQueries({ queryKey })
            }, REALTIME_REFETCH_MS))
        }
        try {
            const filter = `user_id=eq.${uid}`
            const bump = (payload) => {
                const row = payload?.new || payload?.old || {}
                const isBatch = payload?.table === 'aa_batches'
                const batchId = isBatch ? row.id : row.batch_id
                if (payload?.new && batchId) {
                    if (isBatch) {
                        qc.setQueriesData({ queryKey: aaKeys.batch(batchId) }, (old) => (old ? { ...old, batch: { ...old.batch, ...payload.new } } : old))
                        qc.setQueriesData({ queryKey: aaKeys.batches }, (old) =>
                            old && Array.isArray(old.batches)
                                ? { ...old, batches: old.batches.map((b) => (b.id === batchId ? { ...b, ...payload.new } : b)) }
                                : old,
                        )
                    } else if (row.id) {
                        const patch = {}
                        for (const f of TASK_LIVE_FIELDS) if (payload.new[f] !== undefined) patch[f] = payload.new[f]
                        qc.setQueriesData({ queryKey: aaKeys.batch(batchId) }, (old) =>
                            old && Array.isArray(old.tasks)
                                ? { ...old, tasks: old.tasks.map((t) => (t.id === row.id ? { ...t, ...patch } : t)) }
                                : old,
                        )
                    }
                }
                refetchSoon(aaKeys.batches)
                refetchSoon(batchId ? aaKeys.batch(batchId) : ['aa', 'batch'])
                if (row.status === 'needs_you') refetchSoon(aaKeys.needsYou)
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
            for (const t of timers.values()) clearTimeout(t)
            timers.clear()
            if (channel) supabase.removeChannel(channel)
        }
    }, [uid, qc])

    return live
}

// ── Needs you: ONE consolidated form (GET/POST /needs-you/form) ─────
// GET -> { fields[], sites[], unconfirmed[], profile, item_count, accumulating }
export function useNeedsYouForm({ enabled = true } = {}) {
    const uid = useUid()
    return useQuery({
        queryKey: [...aaKeys.needsYou, 'form', uid],
        queryFn: () => aa('/needs-you/form'),
        enabled: !!uid && enabled,
        refetchInterval: 60_000,
    })
}

// body: { answers: {fieldId: value}, sites: {siteId: 'done'}, manual: {itemId: 'applied'|'skip'}, unconfirmed: {itemId: 'yes'|'no'} }
export function useSaveNeedsYouForm({ meta } = {}) {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: (body) => aa('/needs-you/form', { method: 'POST', json: body }),
        meta: { success: 'Saved. We are retrying those applications with your details.', ...meta },
        onSuccess: (d) => {
            qc.setQueriesData({ queryKey: [...aaKeys.needsYou, 'form'] }, () => d)
            return Promise.all([
                qc.invalidateQueries({ queryKey: aaKeys.needsYou }),
                qc.invalidateQueries({ queryKey: aaKeys.answers }),
                qc.invalidateQueries({ queryKey: ['aa', 'batch'] }),
                qc.invalidateQueries({ queryKey: aaKeys.me }),
            ])
        },
    })
}

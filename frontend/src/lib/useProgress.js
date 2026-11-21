import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { supabase } from './supabase'
import { useAuth } from '../contexts/AuthContext'

// Fetch all progress rows for current user + given problem type
export function useProgress(problemType) {
    const { user } = useAuth()
    const queryClient = useQueryClient()

    const { data: rows = [], isLoading, isSuccess, isFetched } = useQuery({
        queryKey: ['progress', user?.id, problemType],
        queryFn: async () => {
            if (!user) return []
            const { data, error } = await supabase
                .from('user_problem_progress')
                .select('*')
                .eq('user_id', user.id)
                .eq('problem_type', problemType)
            if (error) throw error
            return data
        },
        enabled: !!user,
        staleTime: 60_000,          // don't re-fetch within 60s — lets optimistic updates survive
        refetchOnMount: false,
        refetchOnWindowFocus: false, // tab switch must NOT race the in-flight write
    })

    // Build a map: problem_id -> row (memoised so consumers get a stable reference)
    const progressMap = useMemo(
        () => Object.fromEntries((rows || []).map(r => [r.problem_id, r])),
        [rows]
    )

    // ids that exist server-side (from the last fetch) — a row not in here is an
    // INSERT, where we must supply the not-null columns' values explicitly.
    const serverIds = useRef(new Set())
    useEffect(() => { serverIds.current = new Set((rows || []).map(r => r.problem_id)) }, [rows])

    const queryKey = useMemo(() => ['progress', user?.id, problemType], [user?.id, problemType])

    // Writes send ONLY the changed fields (a partial upsert only touches the
    // supplied columns), so a stale snapshot can never clobber a concurrent edit.
    const upsert = useCallback(async (problemId, patch) => {
        if (!user) return
        const payload = {
            user_id: user.id,
            problem_type: problemType,
            problem_id: problemId,
            updated_at: new Date().toISOString(),
            ...patch,
        }
        if (!serverIds.current.has(problemId)) {
            // First write for this problem: fill required columns from the latest cache.
            const cached = (queryClient.getQueryData(['progress', user.id, problemType]) || [])
                .find(r => r.problem_id === problemId)
            if (payload.status === undefined) payload.status = cached?.status ?? 'unsolved'
            if (payload.is_bookmarked === undefined) payload.is_bookmarked = cached?.is_bookmarked ?? false
        }
        const { error } = await supabase
            .from('user_problem_progress')
            .upsert(payload, { onConflict: 'user_id,problem_type,problem_id' })
        if (error) throw error
    }, [user, problemType, queryClient])

    // Always read the freshest cached row at call time (not a render snapshot).
    const getRow = useCallback((problemId) => {
        const cached = queryClient.getQueryData(queryKey) || []
        return cached.find(r => r.problem_id === problemId)
    }, [queryClient, queryKey])

    // Debounced status writes: problem_id -> { timer, next }
    const pending = useRef({})
    const upsertRef = useRef(upsert)
    upsertRef.current = upsert
    const keyRef = useRef(queryKey)
    keyRef.current = queryKey

    const flushOne = useCallback(async (problemId) => {
        const entry = pending.current[problemId]
        if (!entry) return
        clearTimeout(entry.timer)
        delete pending.current[problemId]
        try {
            await entry.upsert(problemId, { status: entry.next })
            queryClient.invalidateQueries({ queryKey: entry.key })
        } catch (err) {
            console.error('Progress save failed:', err)
            // Roll back the optimistic update by re-syncing from the DB
            queryClient.invalidateQueries({ queryKey: entry.key })
        }
    }, [queryClient])

    const flushAll = useCallback(() => {
        Object.keys(pending.current).forEach(id => { flushOne(id) })
    }, [flushOne])

    // Flush pending debounced writes when the tab is hidden / closed / unmounted.
    useEffect(() => {
        const onHide = () => { if (document.visibilityState === 'hidden') flushAll() }
        const onPageHide = () => flushAll()
        document.addEventListener('visibilitychange', onHide)
        window.addEventListener('pagehide', onPageHide)
        return () => {
            document.removeEventListener('visibilitychange', onHide)
            window.removeEventListener('pagehide', onPageHide)
            flushAll()
        }
    }, [flushAll])

    // Optimistic toggle status (solved <-> unsolved)
    const toggleStatus = useCallback((problemId, currentStatus) => {
        const next = currentStatus === 'solved' ? 'unsolved' : 'solved'
        const now = new Date().toISOString()

        queryClient.setQueryData(queryKey, (old = []) => {
            const existing = old.find(r => r.problem_id === problemId)
            if (existing) {
                return old.map(r => r.problem_id === problemId ? { ...r, status: next, updated_at: now } : r)
            }
            return [...old, {
                problem_id: problemId, user_id: user?.id, problem_type: problemType,
                status: next, is_bookmarked: false, notes: null, updated_at: now
            }]
        })

        // Debounced write (400ms trailing)
        const prev = pending.current[problemId]
        if (prev) clearTimeout(prev.timer)
        pending.current[problemId] = {
            next,
            key: queryKey,
            upsert: upsertRef.current,
            timer: setTimeout(() => { flushOne(problemId) }, 400),
        }
    }, [user?.id, problemType, queryClient, queryKey, flushOne])

    const toggleBookmark = useCallback((problemId) => {
        const existing = getRow(problemId)
        const next = !(existing?.is_bookmarked ?? false)

        queryClient.setQueryData(queryKey, (old = []) => {
            const e = old.find(r => r.problem_id === problemId)
            if (e) return old.map(r => r.problem_id === problemId ? { ...r, is_bookmarked: next } : r)
            return [...old, { problem_id: problemId, user_id: user?.id, problem_type: problemType, status: 'unsolved', is_bookmarked: next, notes: null, updated_at: new Date().toISOString() }]
        })
        upsert(problemId, { is_bookmarked: next }).catch(() => {
            queryClient.invalidateQueries({ queryKey })
        })
    }, [user?.id, problemType, queryClient, queryKey, getRow, upsert])

    // Partial write for the `notes` / `state` columns.
    // Contract: pass `undefined` for any argument you want left untouched — only
    // the fields you actually supply are merged into the row. (HLD passes
    // `notes: undefined` because its real notes live inside `state.notes`; LLD/DSA
    // pass only `notes` and leave `state` alone.)
    const saveNotes = useCallback((problemId, notes, state) => {
        const patch = {}
        if (notes !== undefined) patch.notes = notes
        if (state !== undefined) patch.state = state
        upsert(problemId, patch).catch(console.error)
    }, [upsert])

    // `isSuccess` means progress rows have actually loaded for the current user
    // (vs `!isLoading`, which is also false while the query is disabled for a null user).
    return { progressMap, isLoading, isSuccess, isFetched, toggleStatus, toggleBookmark, saveNotes }
}

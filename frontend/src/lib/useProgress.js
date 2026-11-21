import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { supabase } from './supabase'
import { useAuth } from '../contexts/AuthContext'
import { toast } from './toast'
import { errorText } from './errorText'

// Fetch all progress rows for current user + given problem type
export function useProgress(problemType) {
    const { user } = useAuth()
    const queryClient = useQueryClient()
    const uid = user?.id

    const { data: rows = [], isLoading, isSuccess, isFetched } = useQuery({
        queryKey: ['progress', uid, problemType],
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

    // Problem ids whose row is known to exist server-side (loaded from the DB
    // or written successfully). A row not in here is an INSERT, where the
    // not-null columns must be supplied explicitly.
    const known = useRef(new Set())
    useEffect(() => {
        for (const r of rows || []) known.current.add(r.problem_id)
    }, [rows])

    const queryKey = useMemo(() => ['progress', uid, problemType], [uid, problemType])

    const patchCache = useCallback((problemId, patch) => {
        queryClient.setQueryData(queryKey, (old = []) => {
            const e = old.find(r => r.problem_id === problemId)
            if (e) return old.map(r => r.problem_id === problemId ? { ...r, ...patch } : r)
            return [...old, {
                problem_id: problemId, user_id: uid, problem_type: problemType,
                status: 'unsolved', is_bookmarked: false, notes: null, updated_at: new Date().toISOString(), ...patch,
            }]
        })
    }, [queryClient, queryKey, uid, problemType])

    // Writes ONLY the columns in `patch` (a partial upsert only touches the
    // supplied columns), so a stale snapshot can never clobber a concurrent
    // edit — e.g. a status toggle used to write back an old `notes` value. For
    // a first write, the other NOT NULL columns come from the *current* cache
    // (already optimistically up to date), never a render closure.
    const upsert = useCallback(async (problemId, patch) => {
        if (!uid) return
        const payload = {
            user_id: uid,
            problem_type: problemType,
            problem_id: problemId,
            updated_at: new Date().toISOString(),
            ...patch,
        }
        if (!known.current.has(problemId)) {
            const current = (queryClient.getQueryData(queryKey) || []).find(r => r.problem_id === problemId)
            if (payload.status === undefined) payload.status = current?.status ?? 'unsolved'
            if (payload.is_bookmarked === undefined) payload.is_bookmarked = current?.is_bookmarked ?? false
        }
        const { error } = await supabase
            .from('user_problem_progress')
            .upsert(payload, { onConflict: 'user_id,problem_type,problem_id' })
        if (error) throw error
        known.current.add(problemId)
        // the profile page's aggregate view of all progress
        queryClient.invalidateQueries({ queryKey: ['all-progress', uid] })
    }, [uid, problemType, queryClient, queryKey])

    const rollback = useCallback((key, snapshot, what, err) => {
        queryClient.setQueryData(key, snapshot)
        toast.error(`Could not save ${what}: ${errorText(err)}`)
    }, [queryClient])

    // Debounced status writes: problem_id -> { timer, next, key, snap, upsert }.
    // `snap` is the cache before the first click of a burst, so a failure
    // rolls back to what the server actually has.
    const pending = useRef({})

    const flushOne = useCallback(async (problemId) => {
        const entry = pending.current[problemId]
        if (!entry) return
        clearTimeout(entry.timer)
        delete pending.current[problemId]
        try {
            await entry.upsert(problemId, { status: entry.next })
        } catch (err) {
            console.error('Progress save failed:', err)
            rollback(entry.key, entry.snap, 'your progress', err)
        }
    }, [rollback])

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
        const prev = pending.current[problemId]
        const snap = prev ? prev.snap : queryClient.getQueryData(queryKey)
        if (prev) clearTimeout(prev.timer)

        patchCache(problemId, { status: next, updated_at: new Date().toISOString() })

        // Debounced write (400ms trailing)
        pending.current[problemId] = {
            next,
            key: queryKey,
            snap,
            upsert,
            timer: setTimeout(() => { flushOne(problemId) }, 400),
        }
    }, [queryClient, queryKey, patchCache, upsert, flushOne])

    const toggleBookmark = useCallback((problemId) => {
        const snapshot = queryClient.getQueryData(queryKey)
        const existing = (snapshot || []).find(r => r.problem_id === problemId)
        const next = !(existing?.is_bookmarked ?? false)
        patchCache(problemId, { is_bookmarked: next })
        upsert(problemId, { is_bookmarked: next }).catch((err) => rollback(queryKey, snapshot, 'the bookmark', err))
    }, [queryClient, queryKey, patchCache, upsert, rollback])

    // Partial write for the `notes` / `state` columns.
    // Contract: pass `undefined` for any argument you want left untouched — only
    // the fields you actually supply are merged into the row. (HLD passes
    // `notes: undefined` because its real notes live inside `state.notes`; LLD/DSA
    // pass only `notes` and leave `state` alone.)
    // Returns a promise (rejects on failure) so callers can show
    // Saving… / Saved / Failed. The cache is patched at once so a later write
    // or re-render never sees the old value.
    const saveNotes = useCallback((problemId, notes, state) => {
        const patch = {}
        if (notes !== undefined) patch.notes = notes
        if (state !== undefined) patch.state = state
        const snapshot = queryClient.getQueryData(queryKey)
        patchCache(problemId, patch)
        return upsert(problemId, patch).catch((err) => {
            queryClient.setQueryData(queryKey, snapshot)
            console.error('Notes save failed:', err)
            throw err
        })
    }, [queryClient, queryKey, patchCache, upsert])

    // `isSuccess` means progress rows have actually loaded for the current user
    // (vs `!isLoading`, which is also false while the query is disabled for a null user).
    return { progressMap, isLoading, isSuccess, isFetched, toggleStatus, toggleBookmark, saveNotes }
}

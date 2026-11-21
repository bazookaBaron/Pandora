import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'
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

    // Build a map: problem_id -> row
    const progressMap = Object.fromEntries((rows || []).map(r => [r.problem_id, r]))

    // Debounce map: problem_id -> timeout id, plus `snap:<id>` -> pre-burst snapshot
    const debounceTimers = useRef({})
    // Problem ids whose row is known to exist server-side (loaded from the DB
    // or written successfully). Rows only added optimistically are not in it.
    const known = useRef(new Set())
    useEffect(() => {
        for (const r of rows || []) known.current.add(r.problem_id)
    }, [rows])

    const cacheKey = useCallback(() => ['progress', uid, problemType], [uid, problemType])

    const patchCache = useCallback((problemId, patch) => {
        queryClient.setQueryData(cacheKey(), (old = []) => {
            const e = old.find(r => r.problem_id === problemId)
            if (e) return old.map(r => r.problem_id === problemId ? { ...r, ...patch } : r)
            return [...old, {
                problem_id: problemId, user_id: uid, problem_type: problemType,
                status: 'unsolved', is_bookmarked: false, notes: null, updated_at: new Date().toISOString(), ...patch,
            }]
        })
    }, [queryClient, cacheKey, uid, problemType])

    // Writes ONLY the columns in `patch`. The old version spread the row from
    // a stale render's cache into every upsert, so e.g. a status toggle wrote
    // back an old `notes` value and wiped notes saved a moment earlier. For a
    // row that may not exist yet, the other NOT NULL columns come from the
    // *current* cache (already optimistically up to date), never a closure.
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
            const current = (queryClient.getQueryData(cacheKey()) || []).find(r => r.problem_id === problemId)
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
    }, [uid, problemType, queryClient, cacheKey])

    const rollback = useCallback((snapshot, what, err) => {
        queryClient.setQueryData(cacheKey(), snapshot)
        toast.error(`Could not save ${what}: ${errorText(err)}`)
    }, [queryClient, cacheKey])

    // Optimistic toggle status (solved <-> unsolved)
    const toggleStatus = useCallback((problemId, currentStatus) => {
        const next = currentStatus === 'solved' ? 'unsolved' : 'solved'
        const timers = debounceTimers.current
        // Snapshot before the first click of a debounced burst, so a failure
        // rolls back to what the server actually has.
        const snapKey = `snap:${problemId}`
        if (!timers[snapKey]) timers[snapKey] = { data: queryClient.getQueryData(cacheKey()) }

        patchCache(problemId, { status: next, updated_at: new Date().toISOString() })

        // Debounced write (400ms trailing)
        clearTimeout(timers[problemId])
        timers[problemId] = setTimeout(async () => {
            const snap = timers[snapKey]
            delete timers[snapKey]
            try {
                await upsert(problemId, { status: next })
            } catch (err) {
                console.error('Progress save failed:', err)
                rollback(snap?.data, 'your progress', err)
            }
        }, 400)
    }, [queryClient, cacheKey, patchCache, upsert, rollback])

    const toggleBookmark = useCallback((problemId) => {
        const snapshot = queryClient.getQueryData(cacheKey())
        const existing = (snapshot || []).find(r => r.problem_id === problemId)
        const next = !(existing?.is_bookmarked ?? false)
        patchCache(problemId, { is_bookmarked: next })
        upsert(problemId, { is_bookmarked: next }).catch((err) => rollback(snapshot, 'the bookmark', err))
    }, [queryClient, cacheKey, patchCache, upsert, rollback])

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
        const snapshot = queryClient.getQueryData(cacheKey())
        patchCache(problemId, patch)
        return upsert(problemId, patch).catch((err) => {
            queryClient.setQueryData(cacheKey(), snapshot)
            console.error('Notes save failed:', err)
            throw err
        })
    }, [queryClient, cacheKey, patchCache, upsert])

    // `isSuccess` means progress rows have actually loaded for the current user
    // (vs `!isLoading`, which is also false while the query is disabled for a null user).
    return { progressMap, isLoading, isSuccess, isFetched, toggleStatus, toggleBookmark, saveNotes }
}

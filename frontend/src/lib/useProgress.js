import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef } from 'react'
import { supabase } from './supabase'
import { useAuth } from '../contexts/AuthContext'

// Fetch all progress rows for current user + given problem type
export function useProgress(problemType) {
    const { user } = useAuth()
    const queryClient = useQueryClient()

    const { data: rows = [], isLoading } = useQuery({
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
        staleTime: 0,
        refetchOnMount: 'always',
        refetchOnWindowFocus: true,
    })

    // Build a map: problem_id -> row
    const progressMap = Object.fromEntries((rows || []).map(r => [r.problem_id, r]))

    // Debounce map: problem_id -> timeout ref
    const debounceTimers = useRef({})

    const upsert = useCallback(async (problemId, patch) => {
        if (!user) return
        const existing = progressMap[problemId]
        const payload = {
            user_id: user.id,
            problem_type: problemType,
            problem_id: problemId,
            status: existing?.status ?? 'unsolved',
            is_bookmarked: existing?.is_bookmarked ?? false,
            notes: existing?.notes ?? null,
            updated_at: new Date().toISOString(),
            ...patch,
        }
        const { error } = await supabase
            .from('user_problem_progress')
            .upsert(payload, { onConflict: 'user_id,problem_type,problem_id' })
        if (error) throw error
    }, [user, problemType, progressMap])

    // Optimistic toggle status (cycles unsolved → attempted → solved → unsolved, or binary)
    const toggleStatus = useCallback((problemId, currentStatus) => {
        const next = currentStatus === 'solved' ? 'unsolved' : 'solved'

        // Optimistic update in cache
        queryClient.setQueryData(['progress', user?.id, problemType], (old = []) => {
            const existing = old.find(r => r.problem_id === problemId)
            if (existing) {
                return old.map(r => r.problem_id === problemId ? { ...r, status: next, updated_at: new Date().toISOString() } : r)
            }
            return [...old, {
                problem_id: problemId, user_id: user?.id, problem_type: problemType,
                status: next, is_bookmarked: false, notes: null, updated_at: new Date().toISOString()
            }]
        })

        // Debounced write (400ms trailing)
        clearTimeout(debounceTimers.current[problemId])
        debounceTimers.current[problemId] = setTimeout(async () => {
            try {
                await upsert(problemId, { status: next })
            } catch (err) {
                console.error('Progress save failed:', err)
                // Rollback on error
                queryClient.invalidateQueries(['progress', user?.id, problemType])
            }
        }, 400)
    }, [user, problemType, queryClient, upsert])

    const toggleBookmark = useCallback((problemId) => {
        const existing = progressMap[problemId]
        const next = !(existing?.is_bookmarked ?? false)

        queryClient.setQueryData(['progress', user?.id, problemType], (old = []) => {
            const e = old.find(r => r.problem_id === problemId)
            if (e) return old.map(r => r.problem_id === problemId ? { ...r, is_bookmarked: next } : r)
            return [...old, { problem_id: problemId, user_id: user?.id, problem_type: problemType, status: 'unsolved', is_bookmarked: next, notes: null, updated_at: new Date().toISOString() }]
        })
        upsert(problemId, { is_bookmarked: next }).catch(() => {
            queryClient.invalidateQueries(['progress', user?.id, problemType])
        })
    }, [user, problemType, queryClient, progressMap, upsert])

    const saveNotes = useCallback((problemId, notes) => {
        upsert(problemId, { notes }).catch(console.error)
    }, [upsert])

    return { progressMap, isLoading, toggleStatus, toggleBookmark, saveNotes }
}

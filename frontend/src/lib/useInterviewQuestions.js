import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from './supabase'
import { apiFetch } from './apiClient'

// ── 1. All distinct (category, subcategory) pairs ─────────────────
// Server-side catalog endpoint — dedupe happens on the server.
export function useInterviewSubcategories() {
    const { user } = useAuth()
    return useQuery({
        queryKey: ['catalog-interview-subcategories'],
        queryFn: async () => {
            const data = await apiFetch('/api/catalog/interview')
            return data?.subcategories || []
        },
        enabled: !!user,
        staleTime: 10 * 60 * 1000,
    })
}

// ── 2. Questions list for a subcategory ───────────────────────────
// Returns the react-query result with `data` kept as the items array (so
// existing call sites `const { data: questions = [] } = ...` keep working),
// plus flattened `items` / `locked` / `total` / `limit` from the catalog
// response so callers can render a paywall slice for the hidden remainder.
//   { ...query, data: items[], items, locked, total, limit, isLoading, error }
export function useInterviewQuestions(subcategory) {
    const { user } = useAuth()
    const query = useQuery({
        queryKey: ['catalog-interview-questions', subcategory],
        queryFn: async () => {
            const data = await apiFetch(
                '/api/catalog/interview?subcategory=' + encodeURIComponent(subcategory),
            )
            return {
                items: data?.items || [],
                locked: data?.locked || 0,
                total: data?.total || 0,
                limit: data?.limit,
            }
        },
        enabled: !!user && !!subcategory,
        staleTime: 5 * 60 * 1000,
    })

    const payload = query.data || { items: [], locked: 0, total: 0, limit: undefined }
    return {
        ...query,
        data: payload.items,
        items: payload.items,
        locked: payload.locked,
        total: payload.total,
        limit: payload.limit,
    }
}

// ── 3. Lazy answer fetch (only when a question is selected) ───────
// Stays on direct Supabase — RLS-scoped, per-user answer content.
export function useInterviewAnswer(questionId) {
    return useQuery({
        queryKey: ['interview-answer', questionId],
        queryFn: async () => {
            const { data, error } = await supabase
                .from('interview_questions')
                .select('answer, answer_status, chart_config')
                .eq('id', questionId)
                // maybeSingle() → null (not a throw) when a stale stored id no longer matches
                .maybeSingle()
            if (error) throw error
            return data ?? null
        },
        staleTime: 10 * 60 * 1000,
        enabled: !!questionId,
    })
}

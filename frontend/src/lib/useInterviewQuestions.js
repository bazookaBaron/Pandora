import { useQuery } from '@tanstack/react-query'
import { apiFetch, ApiError } from './apiClient'

// ── 1. All distinct (category, subcategory) pairs ─────────────────
// Server-side catalog endpoint — dedupe happens on the server.
export function useInterviewSubcategories() {
    return useQuery({
        queryKey: ['catalog-interview-subcategories'],
        queryFn: async () => {
            const data = await apiFetch('/api/catalog/interview')
            return data?.subcategories || []
        },
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
        enabled: !!subcategory,
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
// Server-side, not direct Supabase: interview_questions RLS only grants
// SELECT to `authenticated` (the answer text is paid content), so a
// logged-out visitor got nothing back for even their free questions. The
// server route re-checks the same free-tier "first N per subcategory" window
// as the question list and works for both anon and signed-in users.
export function useInterviewAnswer(questionId) {
    return useQuery({
        queryKey: ['interview-answer', questionId],
        queryFn: async () => {
            try {
                const data = await apiFetch('/api/catalog/interview/answer/' + encodeURIComponent(questionId))
                return data ?? null
            } catch (err) {
                // 404 = stale/removed id, 403 = outside this plan's unlocked window
                // (shouldn't happen via the UI, which only lists unlocked ids — a
                // stale client cache is the only realistic path). Both render as
                // "this question isn't available", same as the old maybeSingle()->null case.
                if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return null
                throw err
            }
        },
        staleTime: 10 * 60 * 1000,
        enabled: !!questionId,
    })
}

import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'

// ── 1. All distinct (category, subcategory) pairs ─────────────────
export function useInterviewSubcategories() {
    return useQuery({
        queryKey: ['interview-subcategories'],
        queryFn: async () => {
            const { data, error } = await supabase
                .from('interview_questions')
                .select('category, subcategory')
                .order('category')
                .order('subcategory')
            if (error) throw error

            // Deduplicate client-side
            const seen = new Set()
            const unique = []
            for (const row of (data || [])) {
                const key = `${row.category}||${row.subcategory}`
                if (!seen.has(key)) { seen.add(key); unique.push(row) }
            }
            return unique
        },
        staleTime: 10 * 60 * 1000,
    })
}

// ── 2. Questions list for a subcategory ───────────────────────────
export function useInterviewQuestions(subcategory) {
    return useQuery({
        queryKey: ['interview-questions', subcategory],
        queryFn: async () => {
            const { data, error } = await supabase
                .from('interview_questions')
                .select('id, question, order_number, answer_status')
                .eq('subcategory', subcategory)
                // order_number is nullable → add id as a stable tiebreaker
                .order('order_number')
                .order('id', { ascending: true })
            if (error) throw error
            return data || []
        },
        staleTime: 5 * 60 * 1000,
        enabled: !!subcategory,
    })
}

// ── 3. Lazy answer fetch (only when a question is selected) ───────
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

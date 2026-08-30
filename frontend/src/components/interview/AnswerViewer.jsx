import { useEffect, useRef } from 'react'
import { useInterviewAnswer } from '../../lib/useInterviewQuestions'
import { track, EVENTS } from '../../lib/analytics'
import MarkdownRenderer from './MarkdownRenderer'
import ChartBlock from './ChartBlock'
import StatusBadge from './StatusBadge'
import { LoadingState, ErrorState, EmptyState } from '../shared/states'

// ── Answer viewer (middle panel) ─────────────────────────────────────
export default function AnswerViewer({ questionId, questionText, accent = '#22d3ee' }) {
    const { data, isLoading, error } = useInterviewAnswer(questionId)
    const scrollRef = useRef(null)

    // Reset scroll to the top whenever a new question is opened, and again
    // once its answer finishes loading (content height changes under us).
    useEffect(() => {
        const el = scrollRef.current
        if (el) el.scrollTo({ top: 0 })
    }, [questionId, data])

    // SOLUTION_VIEWED once per question — only after the answer is present.
    // Keyed on question id so viewing another question re-arms it; StrictMode-safe.
    const solutionViewedRef = useRef(null)
    useEffect(() => {
        if (!questionId || !data?.answer) return
        if (solutionViewedRef.current === questionId) return
        solutionViewedRef.current = questionId
        track(EVENTS.SOLUTION_VIEWED, { type: 'interview', question_id: questionId })
    }, [questionId, data?.answer])

    if (!questionId) return (
        <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <EmptyState
                icon={(
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#52525b" strokeWidth="1.2" style={{ opacity: 0.4 }}>
                        <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                )}
                title="Select a question from the right panel to view its answer"
            />
        </div>
    )

    if (isLoading) return (
        <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <LoadingState label="" />
        </div>
    )

    if (error) return <ErrorState title="Failed to load answer" err={error} style={{ padding: 24 }} />

    // maybeSingle() returns null when the stored question id no longer exists
    if (data === null) return (
        <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <EmptyState icon="🔍" title="This question is no longer available. Pick another from the list." />
        </div>
    )

    if (data?.answer_status && data.answer_status !== 'completed') return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 }}>
            <div style={{ fontSize: '2rem' }}>🔄</div>
            <div style={{ fontSize: '0.85rem', color: 'var(--accent)', textAlign: 'center', maxWidth: 320 }}>
                Answer is being generated for:<br />
                <strong style={{ color: 'var(--bright)' }}>{questionText}</strong>
            </div>
            <StatusBadge status={data.answer_status} />
        </div>
    )

    const answer = data?.answer
    if (!answer) return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 }}>
            <div style={{ fontSize: '2rem' }}>⏳</div>
            <p style={{ color: 'var(--muted)', fontSize: '0.82rem', textAlign: 'center' }}>Answer not yet generated for this question.</p>
        </div>
    )

    return (
        <div ref={scrollRef} style={{ height: '100%', overflowY: 'auto', padding: '20px 24px' }}>
            {/* Question title */}
            <h2 style={{
                fontSize: '0.95rem', fontWeight: 900, color: 'var(--bright)', marginBottom: 20,
                paddingBottom: 12, borderBottom: `2px solid ${accent}`,
                lineHeight: 1.4, letterSpacing: '-0.01em',
            }}>
                {questionText}
            </h2>

            {data.chart_config && <ChartBlock config={data.chart_config} />}

            {/* Markdown answer */}
            <div style={{ fontSize: '0.84rem', lineHeight: 1.75, color: 'var(--accent)' }}>
                <MarkdownRenderer>{answer}</MarkdownRenderer>
            </div>
        </div>
    )
}

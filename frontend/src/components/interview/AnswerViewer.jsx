import { useEffect, useRef } from 'react'
import { useInterviewAnswer } from '../../lib/useInterviewQuestions'
import { track, EVENTS } from '../../lib/analytics'
import MarkdownRenderer from './MarkdownRenderer'
import ChartBlock from './ChartBlock'
import StatusBadge from './StatusBadge'
import { LoadingState, ErrorState, EmptyState } from '../shared/states'
import { EmptyArt } from '../ui'

// ── Answer viewer (middle panel) ─────────────────────────────────────
// tone = the active category tone ('active' | 'attention' | 'success').
export default function AnswerViewer({ questionId, questionText, tone = 'active' }) {
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
            <EmptyState art="questions" tone={tone} title="Pick a question to see its answer" />
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
            <EmptyState art="search" title="This question is no longer available." message="Pick another from the list." />
        </div>
    )

    if (data?.answer_status && data.answer_status !== 'completed') return (
        <div className="iq-state" aria-live="polite">
            <EmptyArt kind="doc" tone="waiting" size={48} />
            <p>Answer is being generated for:<br /><strong>{questionText}</strong></p>
            <StatusBadge status={data.answer_status} />
        </div>
    )

    const answer = data?.answer
    if (!answer) return (
        <div className="iq-state">
            <EmptyArt kind="doc" tone="history" size={48} />
            <p>No answer yet for this question.</p>
        </div>
    )

    return (
        <div ref={scrollRef} className={`iq-answer tone-${tone}`}>
            {/* Question title */}
            <h2 className="iq-answer-title">{questionText}</h2>

            {data.chart_config && <ChartBlock config={data.chart_config} />}

            {/* Markdown answer */}
            <div style={{ fontSize: '0.84rem', lineHeight: 1.75, color: 'var(--accent)' }}>
                <MarkdownRenderer>{answer}</MarkdownRenderer>
            </div>
        </div>
    )
}

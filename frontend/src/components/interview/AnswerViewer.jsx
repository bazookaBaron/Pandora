import { useEffect, useRef } from 'react'
import { useInterviewAnswer } from '../../lib/useInterviewQuestions'
import MarkdownRenderer from './MarkdownRenderer'
import ChartBlock from './ChartBlock'
import StatusBadge from './StatusBadge'

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

    if (!questionId) return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#52525b', gap: 12, padding: 24 }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ opacity: 0.4 }}>
                <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span style={{ fontSize: '0.82rem', textAlign: 'center' }}>Select a question from the right panel to view its answer</span>
        </div>
    )

    if (isLoading) return (
        <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 28, height: 28, border: '2px solid #27272a', borderTopColor: '#22d3ee', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
        </div>
    )

    if (error) return (
        <div style={{ padding: 24, color: '#f87171', fontSize: '0.82rem' }}>Failed to load answer: {error.message}</div>
    )

    // maybeSingle() returns null when the stored question id no longer exists
    if (data === null) return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 }}>
            <div style={{ fontSize: '2rem' }}>🔍</div>
            <p style={{ color: '#71717a', fontSize: '0.82rem', textAlign: 'center', maxWidth: 320 }}>
                This question is no longer available. Pick another from the list.
            </p>
        </div>
    )

    if (data?.answer_status && data.answer_status !== 'completed') return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 }}>
            <div style={{ fontSize: '2rem' }}>🔄</div>
            <div style={{ fontSize: '0.85rem', color: '#a1a1aa', textAlign: 'center', maxWidth: 320 }}>
                Answer is being generated for:<br />
                <strong style={{ color: '#fafafa' }}>{questionText}</strong>
            </div>
            <StatusBadge status={data.answer_status} />
        </div>
    )

    const answer = data?.answer
    if (!answer) return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 }}>
            <div style={{ fontSize: '2rem' }}>⏳</div>
            <p style={{ color: '#71717a', fontSize: '0.82rem', textAlign: 'center' }}>Answer not yet generated for this question.</p>
        </div>
    )

    return (
        <div ref={scrollRef} style={{ height: '100%', overflowY: 'auto', padding: '20px 24px' }}>
            {/* Question title */}
            <h2 style={{
                fontSize: '0.95rem', fontWeight: 900, color: '#fafafa', marginBottom: 20,
                paddingBottom: 12, borderBottom: `2px solid ${accent}`,
                lineHeight: 1.4, letterSpacing: '-0.01em',
            }}>
                {questionText}
            </h2>

            {data.chart_config && <ChartBlock config={data.chart_config} />}

            {/* Markdown answer */}
            <div style={{ fontSize: '0.84rem', lineHeight: 1.75, color: '#a1a1aa' }}>
                <MarkdownRenderer>{answer}</MarkdownRenderer>
            </div>
        </div>
    )
}

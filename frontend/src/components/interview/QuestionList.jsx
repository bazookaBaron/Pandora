import { useInterviewQuestions } from '../../lib/useInterviewQuestions'
import { ErrorState, EmptyState } from '../shared/states'
import { LockedSlice } from '../shared/PaywallGate'
import StatusBadge from './StatusBadge'

// ── Question list (right panel) ───────────────────────────────────
// tone = the active category tone ('active' | 'attention' | 'success').
export default function QuestionList({ subcategory, activeId, onSelect, tone = 'active' }) {
    const { data: questions = [], isLoading, error, locked = 0 } = useInterviewQuestions(subcategory)

    if (!subcategory) return <EmptyState compact art="questions" title="Select a topic" />
    if (isLoading) return (
        <div style={{ padding: 16 }} role="status" aria-label="Loading questions">
            {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} style={{ height: 44, background: 'var(--panel)', borderRadius: 6, marginBottom: 6, animation: 'pulse 1.5s ease-in-out infinite', opacity: 1 - i * 0.12 }} />
            ))}
        </div>
    )
    if (error) return <ErrorState compact err={error} style={{ margin: 12 }} />
    if (!questions.length) return <EmptyState compact art="questions" title="No questions in this topic" />

    return (
        <div className={`tone-${tone}`} style={{ overflowY: 'auto', height: '100%', padding: '4px 0 8px' }}>
            <ol aria-label={`${subcategory} questions`} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {questions.map((q, idx) => {
                    const isActive = q.id === activeId
                    // answer_status is content-generation state, not the user's progress.
                    // Every published question is 'completed', so only surface the
                    // exceptional states (pending / generating / failed).
                    const showStatus = q.answer_status && q.answer_status !== 'completed'
                    return (
                        <li key={q.id}>
                            <button
                                type="button"
                                className="iq-row iq-q"
                                aria-current={isActive ? 'true' : undefined}
                                onClick={() => onSelect(q.id, q.question)}
                                title={q.question}
                            >
                                <span className="iq-num" aria-hidden="true">{String(q.order_number ?? idx + 1).padStart(2, '0')}</span>
                                <span className="iq-row-text">{q.question}</span>
                                {showStatus && <StatusBadge status={q.answer_status} />}
                            </button>
                        </li>
                    )
                })}
            </ol>
            {locked > 0 && (
                <div style={{ padding: '4px 12px 16px' }}>
                    <LockedSlice variant="row" count={locked} noun="questions in this topic" />
                </div>
            )}
        </div>
    )
}

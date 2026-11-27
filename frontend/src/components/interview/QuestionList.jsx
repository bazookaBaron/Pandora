import { useInterviewQuestions } from '../../lib/useInterviewQuestions'
import { ErrorState, EmptyState } from '../shared/states'
import { LockedSlice } from '../shared/PaywallGate'
import { Row } from '../ui'
import StatusBadge from './StatusBadge'

// ── Question list (right panel / "Questions" tab) ──────────────────
// One Row per question (one line on phones, two from 1024px).
// tone = the active category tone ('active' | 'attention' | 'success').
export default function QuestionList({ subcategory, activeId, onSelect, tone = 'active' }) {
    const { data: questions = [], isLoading, error, locked = 0 } = useInterviewQuestions(subcategory)

    if (!subcategory) return <EmptyState compact art="questions" title="Pick a topic first" />
    if (isLoading) return (
        <ul className="sys-rows iq-rows" role="status" aria-label="Loading questions">
            {Array.from({ length: 6 }).map((_, i) => (
                <li key={i} className="pr-skel"><i style={{ width: 20 }} /><i style={{ flex: 1 }} /></li>
            ))}
        </ul>
    )
    if (error) return <ErrorState compact err={error} style={{ margin: 12 }} />
    if (!questions.length) return <EmptyState compact art="questions" title="No questions in this topic" />

    return (
        <div className={`iq-scroll tone-${tone}`}>
            <ol aria-label={`${subcategory} questions`} className="sys-rows iq-rows iq-qrows">
                {questions.map((q, idx) => {
                    // answer_status is content-generation state, not the user's progress.
                    // Every published question is 'completed', so only surface the
                    // exceptional states (pending / generating / failed).
                    const showStatus = q.answer_status && q.answer_status !== 'completed'
                    return (
                        <li key={q.id}>
                            <Row
                                leading={<span className="iq-num" aria-hidden="true">{String(q.order_number ?? idx + 1).padStart(2, '0')}</span>}
                                title={q.question}
                                meta={showStatus ? <StatusBadge status={q.answer_status} /> : undefined}
                                selected={q.id === activeId}
                                onClick={() => onSelect(q.id, q.question)}
                            />
                        </li>
                    )
                })}
            </ol>
            {locked > 0 && (
                <div style={{ padding: '4px 0 16px' }}>
                    <LockedSlice variant="row" count={locked} noun="questions in this topic" />
                </div>
            )}
        </div>
    )
}

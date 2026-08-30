import { useInterviewQuestions } from '../../lib/useInterviewQuestions'
import { ErrorState, EmptyState } from '../shared/states'
import { LockedSlice } from '../shared/PaywallGate'
import StatusBadge from './StatusBadge'

// Native-button reset so rows are keyboard- and screen-reader-accessible
// while keeping the plain-row look.
const ROW_RESET = {
    appearance: 'none', border: 0, background: 'none', font: 'inherit',
    textAlign: 'left', width: '100%', cursor: 'pointer', display: 'block',
}

// ── Question list (right panel) ───────────────────────────────────
export default function QuestionList({ subcategory, activeId, onSelect, accent = '#22d3ee' }) {
    const { data: questions = [], isLoading, error, locked = 0 } = useInterviewQuestions(subcategory)

    if (!subcategory) return <EmptyState compact title="Select a subcategory" />
    if (isLoading) return (
        <div style={{ padding: 16 }}>
            {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} style={{ height: 52, background: 'var(--panel)', borderRadius: 6, marginBottom: 6, animation: 'pulse 1.5s ease-in-out infinite', opacity: 1 - i * 0.12 }} />
            ))}
        </div>
    )
    if (error) return <ErrorState compact err={error} style={{ margin: 12 }} />
    if (!questions.length) return <EmptyState compact icon="💬" title="No questions in this topic" />



    return (
        <div style={{ overflowY: 'auto', height: '100%', padding: '8px 0' }}>
            <div style={{ padding: '0 12px 6px' }}>
                <span style={{
                    display: 'inline-block', fontSize: '0.6rem', fontWeight: 900,
                    color: accent, textTransform: 'uppercase', letterSpacing: '0.1em',
                    border: `1px solid ${accent}59`, background: `${accent}14`,
                    borderRadius: 4, padding: '2px 7px',
                }}>
                    {questions.length} questions
                </span>
            </div>
            {questions.map((q, idx) => {
                const isActive = q.id === activeId
                // answer_status is content-generation state, not the user's progress.
                // Every published question is 'completed', so only surface the
                // exceptional states (pending / generating / failed).
                const showStatus = q.answer_status && q.answer_status !== 'completed'
                return (
                    <button
                        type="button"
                        key={q.id}
                        onClick={() => onSelect(q.id, q.question)}
                        style={{
                            ...ROW_RESET,
                            padding: '10px 12px',
                            borderLeft: `2px solid ${isActive ? accent : 'transparent'}`,
                            background: isActive ? `${accent}12` : 'transparent',
                            transition: 'background 0.12s, border-color 0.12s',
                        }}
                        onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--panel)' }}
                        onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
                    >
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                            <span style={{ fontSize: '0.6rem', color: `${accent}${isActive ? 'cc' : '59'}`, flexShrink: 0, marginTop: 3, fontFamily: 'monospace' }}>
                                {String(q.order_number ?? idx + 1).padStart(2, '0')}
                            </span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <p style={{
                                    fontSize: '0.8rem', lineHeight: 1.45,
                                    color: isActive ? 'var(--bright)' : 'var(--accent)',
                                    fontWeight: isActive ? 700 : 400,
                                    marginBottom: showStatus ? 5 : 0,
                                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                                }}>
                                    {q.question}
                                </p>
                                {showStatus && <StatusBadge status={q.answer_status} />}
                            </div>
                        </div>
                    </button>
                )
            })}
            {locked > 0 && (
                <div style={{ padding: '4px 12px 16px' }}>
                    <LockedSlice variant="row" count={locked} noun="questions in this topic" />
                </div>
            )}
        </div>
    )
}

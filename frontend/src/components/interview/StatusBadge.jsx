// ── Answer status badge ────────────────────────────────────────────
// Enum values in interview_questions.answer_status:
//   pending | generating | completed | failed
export const STATUS_CONFIG = {
    completed: { label: 'Done', color: '#4ade80', bg: 'rgba(74,222,128,0.1)', border: 'rgba(74,222,128,0.25)' },
    generating: { label: 'Gen…', color: '#22d3ee', bg: 'rgba(34,211,238,0.1)', border: 'rgba(34,211,238,0.25)' },
    pending: { label: 'Pending', color: '#facc15', bg: 'rgba(250,204,21,0.1)', border: 'rgba(250,204,21,0.25)' },
    failed: { label: 'Failed', color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.25)' },
}

export default function StatusBadge({ status }) {
    const cfg = STATUS_CONFIG[status] || { label: status || '…', color: '#71717a', bg: 'transparent', border: '#3f3f46' }
    return (
        <span style={{
            fontSize: '0.58rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.07em',
            padding: '2px 6px', borderRadius: 4, border: `1px solid ${cfg.border}`,
            background: cfg.bg, color: cfg.color, flexShrink: 0,
        }}>{cfg.label}</span>
    )
}

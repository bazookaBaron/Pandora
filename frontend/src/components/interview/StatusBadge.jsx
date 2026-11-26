import Pill from '../ui/Pill'

// ── Answer status badge ────────────────────────────────────────────
// Enum values in interview_questions.answer_status:
//   pending | generating | completed | failed
// Rendered as a shared <Pill>: generating = active (live dot), pending = waiting,
// failed = danger, completed = success. color / bg / border are token strings
// kept for any caller that styles its own element from this map.
export const STATUS_CONFIG = {
    completed: { label: 'Done', tone: 'success', color: 'var(--sys-success)', bg: 'var(--sys-success-dim)', border: 'var(--sys-success)' },
    generating: { label: 'Gen…', tone: 'active', live: true, color: 'var(--sys-active)', bg: 'var(--sys-active-dim)', border: 'var(--sys-active)' },
    pending: { label: 'Pending', tone: 'waiting', color: 'var(--sys-waiting)', bg: 'var(--sys-waiting-dim)', border: 'var(--sys-waiting)' },
    failed: { label: 'Failed', tone: 'danger', color: 'var(--sys-danger)', bg: 'var(--sys-danger-dim)', border: 'var(--sys-danger)' },
}

export default function StatusBadge({ status }) {
    const cfg = STATUS_CONFIG[status] || { label: status || '…', tone: 'history' }
    return (
        <Pill tone={cfg.tone} live={!!cfg.live} soft style={{ flexShrink: 0 }}>{cfg.label}</Pill>
    )
}

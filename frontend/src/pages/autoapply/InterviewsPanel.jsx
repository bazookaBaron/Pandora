import { useInterviews } from '../../lib/useAutoApply'
import InterviewCard from './InterviewCard'

// An interview stays "upcoming" until 2 hours after it starts (or its end time, when known).
const GRACE_MS = 2 * 3600 * 1000

export function splitInterviews(list, nowMs = Date.now()) {
    const upcoming = []
    const past = []
    const unscheduled = []
    for (const iv of list || []) {
        const start = iv.starts_at ? new Date(iv.starts_at).getTime() : NaN
        if (Number.isNaN(start)) { unscheduled.push(iv); continue }
        const endAt = iv.ends_at ? new Date(iv.ends_at).getTime() : NaN
        const end = Number.isNaN(endAt) ? start + GRACE_MS : endAt
        if (end >= nowMs) upcoming.push(iv)
        else past.push(iv)
    }
    upcoming.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))
    past.sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at))
    return { upcoming, past, unscheduled }
}

function Section({ title, items, past = false }) {
    if (!items.length) return null
    return (
        <section aria-label={title} style={{ marginBottom: 22 }}>
            <h2 className="aa-h2">{title} · {items.length}</h2>
            <div className="aa-stack">
                {items.map((iv) => <InterviewCard key={iv.id} iv={iv} past={past} />)}
            </div>
        </section>
    )
}

export default function InterviewsPanel() {
    const q = useInterviews()
    const list = q.data?.interviews || []
    const { upcoming, past, unscheduled } = splitInterviews(list)
    if (q.isLoading || q.isError || list.length === 0) return null
    return (
        <div style={{ marginBottom: 6 }}>
            <Section title="Upcoming" items={upcoming} />
            <Section title="Time not set" items={unscheduled} />
            <Section title="Past" items={past} past />
        </div>
    )
}

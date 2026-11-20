import { Link } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../../components/shared/states'
import { useInterviews } from '../../lib/useAutoApply'
import { AALayout, PageHeader } from './ui'
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
        const end = iv.ends_at ? new Date(iv.ends_at).getTime() : start + GRACE_MS
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

export default function InterviewsPage() {
    const q = useInterviews()
    const list = q.data?.interviews || []
    const { upcoming, past, unscheduled } = splitInterviews(list)
    return (
        <AALayout gate>
            <PageHeader
                eyebrow="Interviews"
                title="Your interviews"
                lead="Interview invites found in your Vloombox mail: when, how to join, and which round. Times are shown in your own time zone; always check the original mail."
                actions={<Link to="/autoapply/inbox?view=interview" className="aa-btn">Interview mails</Link>}
            />
            {q.isLoading ? (
                <LoadingState label="Loading interviews…" />
            ) : q.isError ? (
                <ErrorState err={q.error} onRetry={() => q.refetch()} title="Could not load interviews" />
            ) : list.length === 0 ? (
                <EmptyState icon="📅" title="No interviews yet" message="When a company invites you to an interview, it shows up here with the time and meeting link." />
            ) : (
                <>
                    <Section title="Upcoming" items={upcoming} />
                    <Section title="Time not set" items={unscheduled} />
                    <Section title="Past" items={past} past />
                </>
            )}
        </AALayout>
    )
}

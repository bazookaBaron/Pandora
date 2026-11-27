import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarCheck, MessageSquareReply, Send } from 'lucide-react'
import { EmptyState, ErrorState, LoadingState } from '../../components/shared/states'
import { Row, StatTile, StatTiles } from '../../components/ui'
import { useReplyStats } from '../../lib/useAutoApply'
import { EmptyArt, fmtDate } from './ui'

const pct = (n) => `${(Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 1 })}%`
const SHORT = 5

// Results: 3 tiles (applied, replies, interviews) and a short list of reply rates by role family.
export default function StatsSection() {
    const q = useReplyStats()
    const [all, setAll] = useState(false)
    const d = q.data
    const t = d?.totals
    const rows = d?.by_role || []
    const shown = all ? rows : rows.slice(0, SHORT)
    return (
        <div>
            {q.isLoading ? (
                <LoadingState label="Counting replies…" />
            ) : q.isError ? (
                <ErrorState err={q.error} onRetry={() => q.refetch()} title="Could not load results" />
            ) : !t || t.applied === 0 ? (
                <EmptyState icon={<EmptyArt kind="stats" tone="active" />} title="No applications yet" message="Results show after your first applications."
                    action={<Link to="/autoapply/buy" className="sys-tone-btn aa-tone">See packs</Link>} />
            ) : (
                <div className="aa-stack" style={{ gap: 16 }}>
                    <StatTiles cols={3} style={{ marginBottom: 0 }}>
                        <StatTile icon={Send} tone="success" label="Applied" value={t.applied} />
                        <StatTile icon={MessageSquareReply} tone="active" label="Replies" value={t.replies} hint={pct(t.rate)} />
                        <StatTile icon={CalendarCheck} tone="success" label="Interviews" value={t.interviews} hint={pct(t.interview_rate)} />
                    </StatTiles>
                    <p className="aa-faint" style={{ margin: 0 }}>{`Last ${d?.window_days ?? 90} days${d?.since ? `, since ${fmtDate(d.since, false)}` : ''}`}</p>
                    {rows.length > 0 && (
                        <section aria-labelledby="st-role">
                            <h2 id="st-role" className="aa-h">Replies by role</h2>
                            <ul className="sys-rows">
                                {shown.map((r) => (
                                    <li key={r.key}>
                                        <Row title={`${r.label} · ${r.applied} applied`}
                                            meta={`${pct(r.rate)} replied`} metaTone={r.rate > 0 ? 'success' : undefined} />
                                    </li>
                                ))}
                            </ul>
                            {rows.length > SHORT && (
                                <button type="button" className="aa-btn aa-sheet-btn" style={{ marginTop: 10 }} onClick={() => setAll((v) => !v)}>
                                    {all ? 'Show fewer' : `Show all ${rows.length}`}
                                </button>
                            )}
                        </section>
                    )}
                </div>
            )}
        </div>
    )
}

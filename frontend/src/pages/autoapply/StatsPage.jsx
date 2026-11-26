import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BarChart3, CalendarCheck, MessageSquareReply, Send, XCircle } from 'lucide-react'
import { EmptyState, ErrorState, LoadingState } from '../../components/shared/states'
import { useReplyStats } from '../../lib/useAutoApply'
import { EmptyArt, SectionHead, StatTile, fmtDate, num } from './ui'

const pct = (n) => `${(Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 1 })}%`

function StatsTable({ rows, caption, firstCol }) {
    const [all, setAll] = useState(false)
    const shown = all ? rows : rows.slice(0, 25)
    if (!rows.length) return <p className="aa-faint" style={{ margin: 0 }}>Nothing yet.</p>
    return (
        <>
            <div className="aa-table-wrap">
                <table className="aa-table is-lines">
                    <caption className="aa-sr">{caption}</caption>
                    <thead>
                        <tr>
                            <th scope="col">{firstCol}</th>
                            <th scope="col">Applied</th>
                            <th scope="col">Replies</th>
                            <th scope="col">Interviews</th>
                            <th scope="col">Rejections</th>
                            <th scope="col">Reply rate</th>
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map((r) => (
                            <tr key={r.key}>
                                <td className="aa-strong aa-m-main" data-label={firstCol}>{r.label}</td>
                                <td className="aa-m-hide" data-label="Applied">{num(r.applied)}</td>
                                <td className="aa-m-hide" data-label="Replies">{num(r.replies)}</td>
                                <td className="aa-m-hide" data-label="Interviews">{num(r.interviews)}</td>
                                <td className="aa-m-hide" data-label="Rejections">{num(r.rejections)}</td>
                                <td data-label="Reply rate">
                                    <span className="aa-strong">{pct(r.rate)}</span>
                                    <div className="aa-progress" aria-hidden style={{ marginTop: 4, height: 4 }}><span style={{ width: `${Math.min(100, r.rate)}%` }} /></div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {rows.length > 25 && (
                <button type="button" className="aa-btn" style={{ marginTop: 10 }} onClick={() => setAll((v) => !v)}>
                    {all ? 'Show fewer' : `Show all ${rows.length}`}
                </button>
            )}
        </>
    )
}

export default function StatsSection() {
    const q = useReplyStats()
    const d = q.data
    const t = d?.totals
    return (
        <div>
            <p className="aa-faint" style={{ margin: '0 0 10px' }}>{`Last ${d?.window_days ?? 90} days${d?.since ? ` (since ${fmtDate(d.since, false)})` : ''}`}</p>
            {q.isLoading ? (
                <LoadingState label="Counting replies…" />
            ) : q.isError ? (
                <ErrorState err={q.error} onRetry={() => q.refetch()} title="Could not load stats" />
            ) : !t || t.applied === 0 ? (
                <EmptyState icon={<EmptyArt kind="stats" tone="active" />} title="No applications yet" message="Reply rates show up after your first applications." action={<Link to="/autoapply/buy" className="aa-btn is-primary">Buy a pack</Link>} />
            ) : (
                <div className="aa-stack">
                    <div className="aa-tiles" style={{ marginBottom: 0 }}>
                        <StatTile icon={Send} tone="success" label="Applied" value={t.applied} hint="Last 90 days" />
                        <StatTile icon={MessageSquareReply} tone="active" label="Replies" value={t.replies} hint={`${pct(t.rate)} reply rate`} />
                        <StatTile icon={CalendarCheck} tone="success" label="Interviews" value={t.interviews} hint={`${pct(t.interview_rate)} of applications`} />
                        <StatTile icon={XCircle} tone="history" label="Rejections" value={t.rejections} hint="Kept for 30 days" />
                    </div>
                    <section className="aa-card aa-seg tone-active" aria-labelledby="st-role">
                        <SectionHead id="st-role" icon={BarChart3} tone="active" title="By role family" />
                        <StatsTable rows={d.by_role || []} caption="Reply rates by role family" firstCol="Role family" />
                    </section>
                </div>
            )}
        </div>
    )
}

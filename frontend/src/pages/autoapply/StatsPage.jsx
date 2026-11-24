import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BarChart3, Building2, CalendarCheck, MessageSquareReply, Send, XCircle } from 'lucide-react'
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
                <table className="aa-table">
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
                                <td className="aa-strong" data-label={firstCol}>{r.label}</td>
                                <td data-label="Applied">{num(r.applied)}</td>
                                <td data-label="Replies">{num(r.replies)}</td>
                                <td data-label="Interviews">{num(r.interviews)}</td>
                                <td data-label="Rejections">{num(r.rejections)}</td>
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
            <p className="aa-muted" style={{ margin: '0 0 12px' }}>{`Applications we submitted in the last ${d?.window_days ?? 90} days and the replies they got${d?.since ? ` (since ${fmtDate(d.since, false)})` : ''}.`}</p>
            {q.isLoading ? (
                <LoadingState label="Counting replies…" />
            ) : q.isError ? (
                <ErrorState err={q.error} onRetry={() => q.refetch()} title="Could not load stats" />
            ) : !t || t.applied === 0 ? (
                <EmptyState icon={<EmptyArt kind="stats" tone="active" />} title="No applications yet" message="Reply rates show up once we have applied to jobs for you." action={<Link to="/autoapply/buy" className="aa-btn is-primary">Buy a pack</Link>} />
            ) : (
                <div className="aa-stack">
                    <div className="aa-tiles" style={{ marginBottom: 0 }}>
                        <StatTile icon={Send} tone="success" label="Applied" value={t.applied} hint="Last 90 days" />
                        <StatTile icon={MessageSquareReply} tone="active" label="Got a reply" value={t.replies} hint={`${pct(t.rate)} reply rate`} />
                        <StatTile icon={CalendarCheck} tone="success" label="Interviews" value={t.interviews} hint={`${pct(t.interview_rate)} of applications`} />
                        <StatTile icon={XCircle} tone="history" label="Rejections" value={t.rejections} hint="Kept for 30 days" />
                    </div>
                    <p className="aa-faint" style={{ margin: 0 }}>
                        A reply is any mail from the company other than an automatic &ldquo;application received&rdquo; or a verification code. Each application counts once.
                    </p>
                    <section className="aa-card aa-seg tone-active" aria-labelledby="st-role">
                        <SectionHead id="st-role" icon={BarChart3} tone="active" title="By role family" />
                        <StatsTable rows={d.by_role} caption="Reply rates by role family" firstCol="Role family" />
                    </section>
                    <section className="aa-card aa-seg tone-active" aria-labelledby="st-co">
                        <SectionHead id="st-co" icon={Building2} tone="active" title="By company" />
                        <StatsTable rows={d.by_company} caption="Reply rates by company" firstCol="Company" />
                    </section>
                </div>
            )}
        </div>
    )
}

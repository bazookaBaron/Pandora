import { useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../../components/shared/states'
import { useReplyStats } from '../../lib/useAutoApply'
import { fmtDate, num } from './ui'

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
                <EmptyState title="No applications yet" message="Reply rates show up once we have applied to jobs for you." action={<Link to="/autoapply/buy" className="aa-btn is-primary">Buy a pack</Link>} />
            ) : (
                <div className="aa-stack">
                    <div className="aa-grid">
                        <div className="aa-card"><div className="aa-stat-value">{num(t.applied)}</div><div className="aa-stat-label">Applied</div></div>
                        <div className="aa-card"><div className="aa-stat-value">{pct(t.rate)}</div><div className="aa-stat-label">Got a reply ({num(t.replies)})</div></div>
                        <div className="aa-card"><div className="aa-stat-value">{num(t.interviews)}</div><div className="aa-stat-label">Interviews ({pct(t.interview_rate)})</div></div>
                        <div className="aa-card"><div className="aa-stat-value">{num(t.rejections)}</div><div className="aa-stat-label">Rejections</div></div>
                    </div>
                    <p className="aa-faint" style={{ margin: 0 }}>
                        A reply is any mail from the company other than an automatic &ldquo;application received&rdquo; or a verification code. Each application counts once.
                    </p>
                    <section className="aa-card" aria-labelledby="st-role">
                        <h2 id="st-role" className="aa-h2">By role family</h2>
                        <StatsTable rows={d.by_role} caption="Reply rates by role family" firstCol="Role family" />
                    </section>
                    <section className="aa-card" aria-labelledby="st-co">
                        <h2 id="st-co" className="aa-h2">By company</h2>
                        <StatsTable rows={d.by_company} caption="Reply rates by company" firstCol="Company" />
                    </section>
                </div>
            )}
        </div>
    )
}

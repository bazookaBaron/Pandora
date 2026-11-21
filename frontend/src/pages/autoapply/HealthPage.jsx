import { EmptyState, ErrorState, LoadingState } from '../../components/shared/states'
import { useAdminHealth, useAutoApplyMe } from '../../lib/useAutoApply'
import { AALayout, PageHeader, fmtAgo, fmtDate } from './ui'

const LEVEL = {
    error: ['Error', 't-red'],
    stale: ['Stale', 't-warm'],
    warn: ['Warning', 't-amber'],
    ok: ['OK', 't-green'],
}

function fmtInterval(s) {
    if (!s) return '—'
    if (s < 120) return `${s} s`
    if (s < 7200) return `${Math.round(s / 60)} min`
    return `${Math.round(s / 3600)} h`
}

function statsText(stats) {
    const entries = Object.entries(stats || {}).filter(([k]) => k !== 'interval_s')
    if (!entries.length) return '—'
    return entries.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ')
}

export default function HealthPage() {
    const me = useAutoApplyMe()
    const isAdmin = !!me.data?.is_admin
    const q = useAdminHealth({ enabled: isAdmin })
    const d = q.data

    let body
    if (me.isLoading) body = <LoadingState label="Loading…" />
    else if (!isAdmin) body = <EmptyState title="Admins only" message="This page shows the AutoApply pipeline health to administrators." />
    else if (q.isLoading) body = <LoadingState label="Loading health…" />
    else if (q.isError) body = <ErrorState err={q.error} onRetry={() => q.refetch()} title="Could not load health" />
    else if (!d?.components?.length) body = <EmptyState title="No heartbeats yet" message="Discovery, the scheduler and the workers write a row here when they run." />
    else {
        body = (
            <div className="aa-stack">
                <div className={`aa-note ${d.ok ? 'is-ok' : 'is-warn'}`} role="status">
                    {d.ok ? 'All components are reporting.' : `${d.counts.error} in error, ${d.counts.stale} stale, ${d.counts.warn} warning.`}
                    {' '}<span className="aa-faint">Checked {fmtDate(d.now)} · refreshes every 30 s · stale = no heartbeat for 2 × its interval.</span>
                </div>
                <div className="aa-table-wrap">
                    <table className="aa-table">
                        <caption className="aa-sr">AutoApply component health</caption>
                        <thead>
                            <tr><th scope="col">Component</th><th scope="col">Status</th><th scope="col">Last seen</th><th scope="col">Interval</th><th scope="col">Stats</th></tr>
                        </thead>
                        <tbody>
                            {d.components.map((c) => {
                                const [label, tone] = LEVEL[c.level] || [c.level, 't-muted']
                                return (
                                    <tr key={c.component} style={c.level === 'error' || c.level === 'stale' ? { background: 'var(--danger-bg, rgba(255,80,80,0.08))' } : undefined}>
                                        <td className="aa-strong" data-label="Component">{c.component}</td>
                                        <td data-label="Status">
                                            <span className={`aa-pill ${tone}`}>{label}</span>
                                            {c.level === 'stale' && c.status !== 'ok' && <div className="aa-faint" style={{ marginTop: 4 }}>last status: {c.status}</div>}
                                        </td>
                                        <td data-label="Last seen">{fmtAgo(c.last_seen) || '—'}<div className="aa-faint">{fmtDate(c.last_seen)}</div></td>
                                        <td data-label="Interval">{fmtInterval(c.interval_s)}</td>
                                        <td data-label="Stats" style={{ overflowWrap: 'anywhere', maxWidth: 420 }} className="aa-faint">{statsText(c.stats)}</td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            </div>
        )
    }

    return (
        <AALayout>
            <PageHeader eyebrow="Admin" title="AutoApply health" lead="Heartbeats from discovery, the scheduler and every worker." />
            {body}
        </AALayout>
    )
}

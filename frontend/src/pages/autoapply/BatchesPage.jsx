import { Link } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../../components/shared/states'
import { useAutoApplyRealtime, useBatches } from '../../lib/useAutoApply'
import { AALayout, BatchStatusPill, PACK_KINDS, PageHeader, Progress, fmtDate, rupees } from './ui'

export default function BatchesPage() {
    const live = useAutoApplyRealtime()
    const q = useBatches({ live })
    const batches = q.data?.batches || []

    return (
        <AALayout gate>
            <PageHeader
                eyebrow="Batches"
                title="Your AutoApply batches"
                lead={live ? 'Live: updates appear as we apply.' : 'Refreshes every 15 seconds.'}
                actions={<Link to="/autoapply/buy" className="aa-btn is-primary">Buy a pack</Link>}
            />
            {q.isLoading ? (
                <LoadingState label="Loading batches…" />
            ) : q.isError ? (
                <ErrorState err={q.error} onRetry={() => q.refetch()} title="Could not load batches" />
            ) : batches.length === 0 ? (
                <EmptyState icon="📭" title="No batches yet" message="Buy a pack and we start applying for you." action={<Link to="/autoapply/buy" className="aa-btn is-primary">Buy a pack</Link>} />
            ) : (
                <ul className="aa-list">
                    {batches.map((b) => (
                        <li key={b.id}>
                            <Link to={`/autoapply/batches/${b.id}`} className="aa-card" style={{ display: 'block', textDecoration: 'none' }}>
                                <div className="aa-spread" style={{ marginBottom: 10 }}>
                                    <div>
                                        <div style={{ color: 'var(--bright)', fontWeight: 900, fontSize: '0.88rem' }}>
                                            {PACK_KINDS[b.pack_kind]?.name || b.pack_kind} · {b.pack_size} applications
                                        </div>
                                        <div className="aa-faint">
                                            {b.purchased_at ? `Bought ${fmtDate(b.purchased_at, false)}` : `Created ${fmtDate(b.created_at, false)}`}
                                            {b.price_paise != null && ` · ${rupees(b.price_paise)}`}
                                            {b.window_days && ` · last ${b.window_days} days`}
                                            {b.expires_at && ` · credits expire ${fmtDate(b.expires_at, false)}`}
                                        </div>
                                    </div>
                                    <BatchStatusPill status={b.status} />
                                </div>
                                <Progress used={b.credits_used} total={b.credits_total} />
                                {b.status === 'waiting_profile' && (
                                    <div className="aa-note is-warn" style={{ marginTop: 10 }}>
                                        Waiting for your profile{Array.isArray(b.waiting_detail?.missing) && b.waiting_detail.missing.length
                                            ? `: ${b.waiting_detail.missing.map((m) => m.label || m.key).join(', ')}` : ''}. Open the batch to complete it.
                                    </div>
                                )}
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </AALayout>
    )
}

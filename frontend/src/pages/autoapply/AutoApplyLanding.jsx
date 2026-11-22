import { Link } from 'react-router-dom'
import { ErrorState, LoadingState } from '../../components/shared/states'
import { useAutoApplyMe, useAutoApplyRealtime, useBatches, useNeedsYou } from '../../lib/useAutoApply'
import AAProgressGuide from '../../components/onboarding/AAProgressGuide'
import { AALayout, PageHeader, ACTIVE_BATCH, BatchStatusPill, PACK_KINDS, PACK_SIZES, Progress, UpgradeCard, fmtDate, packPrice, rupees } from './ui'

const KIND_COLOR = { service: 'var(--pop)', product: 'var(--warm)' }

function PipelineCard({ kind, config, action }) {
    const meta = PACK_KINDS[kind]
    const prices = PACK_SIZES.map((s) => packPrice(config, kind, s)).filter((p) => p != null)
    return (
        <div className="aa-card aa-pipe">
            <div className="aa-pipe-kind" style={{ color: KIND_COLOR[kind] }}>{meta.short}-based</div>
            <p className="aa-muted aa-pipe-blurb">{meta.blurb}</p>
            <div className="aa-spread">
                <span className="aa-pipe-price">
                    {PACK_SIZES.join(' / ')} apps{prices.length ? ` · from ${rupees(Math.min(...prices))}` : ''}
                </span>
                {action}
            </div>
        </div>
    )
}

function BatchRow({ b }) {
    const used = b.credits_used ?? 0
    const total = b.credits_total ?? b.pack_size ?? 0
    return (
        <li>
            <Link to={`/autoapply/batches/${b.id}`} className="aa-card aa-batch-row">
                <span className="aa-batch-kind">{PACK_KINDS[b.pack_kind]?.short || b.pack_kind}</span>
                <BatchStatusPill status={b.status} />
                <span className="aa-batch-prog">
                    <Progress used={b.credits_used} total={b.credits_total} />
                </span>
                <span className="aa-faint aa-batch-count">{used}/{total}</span>
                <span className="aa-faint aa-batch-date">{fmtDate(b.purchased_at || b.created_at, false)}</span>
            </Link>
        </li>
    )
}

function BatchGroup({ title, items }) {
    if (!items.length) return null
    return (
        <div>
            <h3 className="aa-h2" style={{ margin: '0 0 8px' }}>{title} · {items.length}</h3>
            <ul className="aa-list">{items.map((b) => <BatchRow key={b.id} b={b} />)}</ul>
        </div>
    )
}

function Batches() {
    const live = useAutoApplyRealtime()
    const q = useBatches({ live })
    const all = q.data?.batches || []
    const ongoing = all.filter((b) => ACTIVE_BATCH.includes(b.status))
    const done = all.filter((b) => !ACTIVE_BATCH.includes(b.status))
    return (
        <section aria-labelledby="aa-batches" className="aa-stack">
            <h2 id="aa-batches" className="aa-h2" style={{ margin: 0 }}>Batches</h2>
            {q.isLoading ? (
                <LoadingState compact label="Loading batches…" />
            ) : q.isError ? (
                <ErrorState compact err={q.error} onRetry={() => q.refetch()} />
            ) : all.length === 0 ? (
                <p className="aa-muted" style={{ margin: 0 }}>No batches yet. Start a pack above.</p>
            ) : (
                <>
                    <BatchGroup title="Ongoing" items={ongoing} />
                    <BatchGroup title="Completed" items={done} />
                </>
            )}
        </section>
    )
}

export default function AutoApplyLanding() {
    const me = useAutoApplyMe()
    const data = me.data
    const needs = useNeedsYou({ enabled: !!data?.eligible })
    const needCount = data?.eligible ? (needs.data?.items?.length || 0) : 0

    return (
        <AALayout>
            <PageHeader
                title="AutoApply"
                lead="Buy a pack, set your preferences once, and we submit applications for you."
                actions={needCount > 0 && (
                    <Link to="/autoapply/needs-you" className="aa-chip-link" aria-label={`${needCount} applications need you`}>
                        Needs you ({needCount})
                    </Link>
                )}
            />

            {me.isLoading && <LoadingState label="Loading…" />}
            {me.isError && <ErrorState compact err={me.error} onRetry={() => me.refetch()} style={{ marginBottom: 20 }} />}
            {data && !data.eligible && <div style={{ marginBottom: 16 }}><UpgradeCard plan={data.plan} /></div>}

            <AAProgressGuide />

            {data && (
                <section data-tour="autoapply-pipeline" aria-labelledby="aa-pipe" style={{ marginBottom: 22 }}>
                    <h2 id="aa-pipe" className="aa-h2">Pipeline</h2>
                    <div className="aa-grid-2 aa-pipe-grid">
                        {['service', 'product'].map((kind) => (
                            <PipelineCard
                                key={kind}
                                kind={kind}
                                config={data.config}
                                action={data.eligible ? (
                                    <Link to={`/autoapply/buy?kind=${kind}`} className="aa-btn is-primary">{data.onboarding_done ? 'Start' : 'Buy'}</Link>
                                ) : (
                                    <Link to="/pricing" className="aa-btn is-primary">Upgrade</Link>
                                )}
                            />
                        ))}
                    </div>
                    <p className="aa-faint" style={{ margin: '8px 0 0' }}>Credits are used only when an application is submitted. Prices include GST.</p>
                </section>
            )}

            {data?.eligible && <Batches />}
            {data?.is_admin && <p style={{ marginTop: 20 }}><Link to="/autoapply/admin/health" className="aa-faint">Health</Link></p>}
        </AALayout>
    )
}

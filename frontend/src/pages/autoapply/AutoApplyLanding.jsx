import { Link } from 'react-router-dom'
import { CalendarCheck, CheckCircle2, Coins, Hand, History, Layers, Radio, ShoppingBag } from 'lucide-react'
import { EmptyState, ErrorState, LoadingState } from '../../components/shared/states'
import { useAutoApplyMe, useAutoApplyRealtime, useBatches, useInterviews, useNeedsYou } from '../../lib/useAutoApply'
import AAProgressGuide from '../../components/onboarding/AAProgressGuide'
import { splitInterviews } from './InterviewsPanel'
import {
    AALayout, PageHeader, ACTIVE_BATCH, BatchStatusPill, EmptyArt, PACK_KINDS, PACK_SIZES, Progress, SectionHead, StackBar,
    StatTile, UpgradeCard, batchTone, fmtDate, num, packPrice, rupees,
} from './ui'

const KIND_COLOR = { service: 'var(--pop)', product: 'var(--warm)' }

function PipelineCard({ kind, config, eligible, onboardingDone }) {
    const meta = PACK_KINDS[kind]
    const prices = PACK_SIZES.map((s) => packPrice(config, kind, s)).filter((p) => p != null)
    const from = prices.length ? ` · from ${rupees(Math.min(...prices))}` : ''
    return (
        <div className="aa-card aa-pipe">
            <div className="aa-pipe-kind" style={{ color: KIND_COLOR[kind] }}>{meta.short}-based</div>
            <p className="aa-muted aa-pipe-blurb">{meta.blurb}</p>
            <div className="aa-pipe-price">{PACK_SIZES.join(' / ')} apps</div>
            {eligible ? (
                <Link to={`/autoapply/buy?kind=${kind}`} className="aa-btn is-primary aa-pipe-buy" aria-label={`${onboardingDone ? 'Start' : 'Buy'} ${meta.short} pack${from}`}>
                    Buy{prices.length ? ` · from ${rupees(Math.min(...prices))}` : ''}
                </Link>
            ) : (
                <Link to="/pricing" className="aa-btn is-primary aa-pipe-buy">Upgrade</Link>
            )}
        </div>
    )
}

// One card per batch: kind + status, a stacked bar of where its applications are, and the live sentence.
function BatchCard({ b }) {
    const used = b.credits_used ?? 0
    const total = b.credits_total ?? b.pack_size ?? 0
    const live = b.live
    const busy = live && (live.phase === 'applying' || live.phase === 'starting')
    const kind = PACK_KINDS[b.pack_kind]?.short || b.pack_kind
    return (
        <li>
            <Link to={`/autoapply/batches/${b.id}`} className={`aa-card aa-bcard tone-${batchTone(b.status)}`}
                aria-label={`${kind} batch, ${num(used)} of ${num(total)} applied${live?.message ? `. ${live.message}` : ''}`}>
                <span className="aa-bcard-top">
                    <span className="aa-bcard-kind">{kind} · {num(total)}</span>
                    <BatchStatusPill status={b.status} />
                    <span className="aa-faint aa-bcard-meta">{num(used)}/{num(total)} · {fmtDate(b.purchased_at || b.created_at, false)}</span>
                </span>
                {live?.buckets ? <StackBar buckets={live.buckets} total={total} legend /> : <Progress used={used} total={total} />}
                {live?.message && (
                    <span className="aa-bcard-msg">
                        {busy
                            ? <span className="aa-flow-dot" aria-hidden="true" style={{ marginTop: 4 }} />
                            : <Radio size={13} aria-hidden="true" style={{ flex: 'none', marginTop: 2, color: 'var(--muted)' }} />}
                        {live.message}
                    </span>
                )}
            </Link>
        </li>
    )
}

function Batches({ q }) {
    const all = q.data?.batches || []
    const ongoing = all.filter((b) => ACTIVE_BATCH.includes(b.status))
    const done = all.filter((b) => !ACTIVE_BATCH.includes(b.status))
    if (q.isLoading) return <LoadingState compact label="Loading batches…" />
    if (q.isError) return <ErrorState compact err={q.error} onRetry={() => q.refetch()} />
    if (!all.length) {
        return (
            <section className="aa-card aa-seg tone-active" aria-label="Batches">
                <EmptyState compact icon={<EmptyArt kind="batches" tone="active" />}
                    title="No batches yet"
                    message="Buy a pack to start."
                    action={<Link to="/autoapply/buy" className="aa-btn is-primary"><ShoppingBag size={13} aria-hidden="true" /> Buy a pack</Link>} />
            </section>
        )
    }
    return (
        <div className="aa-stack" style={{ gap: 16 }}>
            {ongoing.length > 0 && (
                <section aria-labelledby="aa-ongoing">
                    <SectionHead id="aa-ongoing" icon={Layers} tone="active" title="Ongoing batches" count={ongoing.length} />
                    <ul className="aa-list">{ongoing.map((b) => <BatchCard key={b.id} b={b} />)}</ul>
                </section>
            )}
            {done.length > 0 && (
                <section aria-labelledby="aa-past">
                    <SectionHead id="aa-past" icon={History} tone="history" title="Past batches" count={done.length} />
                    <ul className="aa-list">{done.map((b) => <BatchCard key={b.id} b={b} />)}</ul>
                </section>
            )}
        </div>
    )
}

function KeyNumbers({ batches, needCount }) {
    const ivs = useInterviews()
    const all = batches || []
    const active = all.filter((b) => ACTIVE_BATCH.includes(b.status))
    const creditsLeft = active.reduce((n, b) => n + Math.max(0, (Number(b.credits_total ?? b.pack_size) || 0) - (Number(b.credits_used) || 0)), 0)
    const applied = all.reduce((n, b) => n + (Number(b.credits_used) || 0), 0)
    const { upcoming } = splitInterviews(ivs.data?.interviews || [])
    return (
        <div className="aa-tiles" role="list" aria-label="Key numbers">
            <div role="listitem" style={{ display: 'grid' }}>
                <StatTile icon={Coins} tone="active" label="Credits left" value={creditsLeft}
                    hint={active.length ? `${active.length} ongoing batch${active.length === 1 ? '' : 'es'}` : 'Buy a pack to start'}
                    to={active.length ? undefined : '/autoapply/buy'} />
            </div>
            <div role="listitem" style={{ display: 'grid' }}>
                <StatTile icon={CheckCircle2} tone="success" label="Applied" value={applied} />
            </div>
            <div role="listitem" style={{ display: 'grid' }}>
                <StatTile icon={Hand} tone="attention" label="Needs you" value={needCount}
                    hint={needCount ? 'Answer to continue' : 'Nothing waiting'} to={needCount ? '/autoapply/needs-you' : undefined} />
            </div>
            <div role="listitem" style={{ display: 'grid' }}>
                <StatTile icon={CalendarCheck} tone="success" label="Interviews" value={upcoming.length}
                    hint={upcoming.length ? 'Upcoming' : 'None scheduled'} to="/autoapply/inbox?f=interview" />
            </div>
        </div>
    )
}

// batches are only fetched for an eligible (paid) user
function WithBatches({ children }) {
    const live = useAutoApplyRealtime()
    return children(useBatches({ live }))
}

export default function AutoApplyLanding() {
    const me = useAutoApplyMe()
    const data = me.data
    const eligible = !!data?.eligible
    const needs = useNeedsYou({ enabled: eligible })
    const needCount = eligible ? (needs.data?.items?.length || 0) : 0
    const pipeline = data && (
        <section data-tour="autoapply-pipeline" aria-labelledby="aa-pipe" style={{ marginBottom: 16 }}>
            <SectionHead id="aa-pipe" icon={ShoppingBag} tone="active" title="Buy a pack" />
            <div className="aa-grid-2 aa-pipe-grid">
                {['service', 'product'].map((kind) => (
                    <PipelineCard key={kind} kind={kind} config={data.config} eligible={eligible} onboardingDone={data.onboarding_done} />
                ))}
            </div>
        </section>
    )

    return (
        <AALayout>
            <PageHeader
                title="AutoApply"
                lead="We apply to jobs for you."
                actions={needCount > 0 && (
                    <Link to="/autoapply/needs-you" className="aa-chip-link" aria-label={`${needCount} applications need you`}>
                        Needs you ({needCount})
                    </Link>
                )}
            />

            {me.isLoading && <LoadingState label="Loading…" />}
            {me.isError && <ErrorState compact err={me.error} onRetry={() => me.refetch()} style={{ marginBottom: 20 }} />}
            {data && !eligible && <div style={{ marginBottom: 16 }}><UpgradeCard plan={data.plan} /></div>}

            {eligible ? (
                <WithBatches>
                    {(batchesQ) => (
                        <>
                            <KeyNumbers batches={batchesQ.data?.batches} needCount={needCount} />
                            <AAProgressGuide />
                            {pipeline}
                            <Batches q={batchesQ} />
                        </>
                    )}
                </WithBatches>
            ) : (
                <>
                    <AAProgressGuide />
                    {pipeline}
                </>
            )}
            {data?.is_admin && <p style={{ marginTop: 20 }}><Link to="/autoapply/admin/health" className="aa-faint">Health</Link></p>}
        </AALayout>
    )
}

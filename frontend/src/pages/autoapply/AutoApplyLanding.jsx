import { Link } from 'react-router-dom'
import { ErrorState, LoadingState } from '../../components/shared/states'
import { useAutoApplyMe, useBatches, useNeedsYou } from '../../lib/useAutoApply'
import {
    AALayout, ACTIVE_BATCH, BatchStatusPill, PACK_KINDS, PACK_SIZES, PageHeader, Progress, UpgradeCard,
    num, packPrice, rupees,
} from './ui'

const HOW = [
    ['Set up once', 'Upload your resume, answer the standard application questions and pick the roles and cities you want.'],
    ['Buy a pack', 'Choose service-based or product-based companies and how fresh the postings should be (1 to 30 days).'],
    ['We apply', 'Vloombox fills and submits the applications on company career sites (Workday, Greenhouse, Lever, Ashby and more).'],
    ['You stay in control', 'Review the shortlist first if you like, pause anytime, and step in only when a site needs a human.'],
]

function PackColumn({ kind, config }) {
    const meta = PACK_KINDS[kind]
    return (
        <div className="aa-card">
            <div style={{ fontSize: '0.7rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: kind === 'service' ? 'var(--pop)' : 'var(--warm)' }}>
                {meta.name}
            </div>
            <p className="aa-muted" style={{ margin: '4px 0 12px' }}>{meta.blurb}</p>
            <ul className="aa-list">
                {PACK_SIZES.map((size) => {
                    const price = packPrice(config, kind, size)
                    return (
                        <li key={size} className="aa-spread" style={{ padding: '8px 0', borderBottom: '1px solid var(--subtle)' }}>
                            <span style={{ color: 'var(--bright)', fontWeight: 800, fontSize: '0.84rem' }}>{size} applications</span>
                            <span style={{ color: 'var(--bright)', fontWeight: 900 }}>
                                {price != null ? rupees(price) : <span className="aa-faint">Price at checkout</span>}
                            </span>
                        </li>
                    )
                })}
            </ul>
        </div>
    )
}

function MyStatus({ me }) {
    const batches = useBatches()
    const needs = useNeedsYou()
    const u = me.usage || {}
    const active = (batches.data?.batches || []).filter((b) => ACTIVE_BATCH.includes(b.status))
    const needCount = needs.data?.items?.length || 0

    return (
        <section className="aa-stack" aria-label="Your AutoApply" style={{ marginBottom: 26 }}>
            {!me.onboarding_done && (
                <div className="aa-note is-warn aa-spread">
                    <span>Finish setup (resume, answers, preferences, email) before your first pack.</span>
                    <Link to="/autoapply/setup" className="aa-btn is-primary">Continue setup</Link>
                </div>
            )}
            {needCount > 0 && (
                <div className="aa-note is-info aa-spread">
                    <span>{needCount} application{needCount === 1 ? '' : 's'} need{needCount === 1 ? 's' : ''} you (captcha, sign-in or a question).</span>
                    <Link to="/autoapply/needs-you" className="aa-btn is-warm">Open</Link>
                </div>
            )}
            <div className="aa-grid">
                <div className="aa-card">
                    <div className="aa-stat-value">{num(u.month_applied)}</div>
                    <div className="aa-stat-label">Applied this month</div>
                </div>
                <div className="aa-card">
                    <div className="aa-stat-value">{num(u.month_purchased)} <span className="aa-faint">/ {num(u.monthly_cap ?? 1000)}</span></div>
                    <div className="aa-stat-label">Purchased this month</div>
                </div>
                <div className="aa-card">
                    <div className="aa-stat-value">{num(u.today_applied)} <span className="aa-faint">/ {num(u.daily_cap)}</span></div>
                    <div className="aa-stat-label">Applied today</div>
                </div>
            </div>
            {batches.isLoading ? (
                <LoadingState compact label="Loading batches…" />
            ) : batches.isError ? (
                <ErrorState compact err={batches.error} onRetry={() => batches.refetch()} />
            ) : active.length > 0 && (
                <div className="aa-stack">
                    {active.slice(0, 3).map((b) => (
                        <Link key={b.id} to={`/autoapply/batches/${b.id}`} className="aa-card" style={{ textDecoration: 'none' }}>
                            <div className="aa-spread" style={{ marginBottom: 10 }}>
                                <span style={{ color: 'var(--bright)', fontWeight: 900, fontSize: '0.84rem' }}>
                                    {PACK_KINDS[b.pack_kind]?.short || b.pack_kind} · {b.pack_size}
                                </span>
                                <BatchStatusPill status={b.status} />
                            </div>
                            <Progress used={b.credits_used} total={b.credits_total} />
                        </Link>
                    ))}
                </div>
            )}
            <div className="aa-row">
                <Link to="/autoapply/buy" className="aa-btn is-primary">Buy a pack</Link>
                <Link to="/autoapply/batches" className="aa-btn">All batches</Link>
            </div>
        </section>
    )
}

export default function AutoApplyLanding() {
    const me = useAutoApplyMe()
    const data = me.data
    const cap = data?.config?.monthly_cap ?? data?.usage?.monthly_cap ?? 1000

    return (
        <AALayout>
            <PageHeader
                eyebrow="AutoApply"
                title="We apply to jobs for you."
                lead="Vloombox finds fresh openings that match your profile and submits the applications on the company's own career site, using your resume and your answers."
            />

            {me.isLoading && <LoadingState label="Loading…" />}
            {me.isError && <ErrorState compact err={me.error} onRetry={() => me.refetch()} style={{ marginBottom: 20 }} />}
            {data && (data.eligible ? <MyStatus me={data} /> : <div style={{ marginBottom: 26 }}><UpgradeCard plan={data.plan} /></div>)}

            <section aria-labelledby="aa-how" style={{ marginBottom: 26 }}>
                <h2 id="aa-how" className="aa-h2">How it works</h2>
                <ol className="aa-grid" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {HOW.map(([t, d], i) => (
                        <li key={t} className="aa-card">
                            <div className="aa-faint" style={{ fontWeight: 900 }}>0{i + 1}</div>
                            <div style={{ color: 'var(--bright)', fontWeight: 900, fontSize: '0.86rem', margin: '4px 0 6px' }}>{t}</div>
                            <div className="aa-muted">{d}</div>
                        </li>
                    ))}
                </ol>
            </section>

            <section aria-labelledby="aa-packs" style={{ marginBottom: 26 }}>
                <h2 id="aa-packs" className="aa-h2">Packs</h2>
                <div className="aa-grid-2">
                    <PackColumn kind="service" config={data?.config} />
                    <PackColumn kind="product" config={data?.config} />
                </div>
                <ul className="aa-check-list" style={{ marginTop: 16 }}>
                    <li>Credits are used only when an application is actually submitted. Skipped or failed jobs cost nothing.</li>
                    <li>Up to {num(cap)} applications per account per month.</li>
                    <li>Credits stay valid for {data?.config?.credit_validity_days ?? 90} days; unused credits are refunded pro rata when a pack expires or you cancel it.</li>
                    <li>Requires an active Pro or Max plan. Prices include GST.</li>
                </ul>
            </section>

            <div className="aa-row">
                {data?.eligible ? (
                    <Link to={data.onboarding_done ? '/autoapply/buy' : '/autoapply/setup'} className="aa-btn is-primary">
                        {data.onboarding_done ? 'Buy a pack' : 'Start setup'}
                    </Link>
                ) : (
                    <Link to="/pricing" className="aa-btn is-primary">Upgrade to Pro or Max</Link>
                )}
            </div>
        </AALayout>
    )
}

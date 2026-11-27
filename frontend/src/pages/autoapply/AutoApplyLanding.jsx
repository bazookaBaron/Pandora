import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BarChart3, CalendarCheck, CheckCircle2, Hand, History, Inbox, KeyRound, Radio, RotateCcw, UserCog, Wallet } from 'lucide-react'
import { ErrorState, LoadingState } from '../../components/shared/states'
import { HelpChip, PageHeader, Row, Sheet, StatTile, StatTiles, StatusBanner } from '../../components/ui'
import { CTA, TERMS } from '../../lib/copy'
import { track, TRACK } from '../../lib/track'
import {
    useAutoApplyMe, useAutoApplyRealtime, useBatches, useInboxUnread, useInterviews, useNeedsYou, useSupply, useWallet,
} from '../../lib/useAutoApply'
import WalletTopUp from './WalletTopUp'
import './wallet.css'
import { splitInterviews } from './InterviewsPanel'
import {
    AALayout, ACTIVE_BATCH, BatchStatusPill, PRICE_LINE, SETUP_ORDER, batchTone, fmtDate, matchShown, num,
    packTitle, readSetupStep, rupees, setupLinkFor,
} from './ui'

// ── Not bought yet: the sales screen ────────────────────────────────
const HOW = ['Tell us the job you want', 'Add money to your wallet', 'We apply to matching jobs', 'Replies land in your inbox']
const FAQ = [
    ['Do you apply with my resume?', 'Yes. We fill each form with your resume and your saved answers.'],
    ['What if a form asks something new?', 'We ask you once under Answers needed. Then we keep applying.'],
    ['What does it cost?', 'You only pay for applications we actually submit. Nothing is taken for jobs we skip.'],
    ['Can I stop a batch?', 'Yes. Pause or stop it any time. Money for applications we did not send stays in your wallet.'],
]

// Live count from GET /supply (same broadening ladder as the buy page), the larger of the two pack kinds.
function MatchCount({ config }) {
    const wd = config?.window_days_default ?? 30
    const sv = useSupply('service', wd, 50)
    const pr = useSupply('product', wd, 50)
    const loading = sv.isLoading || pr.isLoading
    const failed = sv.isError && pr.isError
    const count = (sv.data?.count || 0) + (pr.data?.count || 0)
    if (failed) return null
    return (
        <section className="aa-hero" aria-label="Matching jobs" aria-busy={loading}>
            <p className="aa-hero-count" aria-live="polite">
                {loading ? <span className="aa-skel" aria-label="Counting matching jobs" /> : <strong>{matchShown(count, 50)}</strong>}
                <span>jobs match you</span>
                <HelpChip term="matchCount" />
            </p>
            <p className="aa-hero-sub">{PRICE_LINE(config)}</p>
        </section>
    )
}

function SalesScreen({ me }) {
    const data = me.data || {}
    const saved = readSetupStep()
    const k = saved ? SETUP_ORDER.indexOf(saved) + 1 : 0
    const cta = data.onboarding_done
        ? { label: 'Start a batch', to: '/autoapply/buy', id: 'start_batch' }
        : k > 1
            ? { label: `Continue setup (step ${k} of ${SETUP_ORDER.length})`, to: `/autoapply/account?step=${saved}`, id: 'continue_setup' }
            : { label: CTA.getStarted, to: '/autoapply/account', id: 'get_started' }
    return (
        <>
            <MatchCount config={data.config} />

            <section aria-labelledby="aa-how-h" className="aa-block">
                <h2 id="aa-how-h" className="aa-h">How it works</h2>
                <ol className="aa-how">
                    {HOW.map((t, i) => (
                        <li key={t}><span className="aa-how-n" aria-hidden="true">{i + 1}</span><span>{t}</span></li>
                    ))}
                </ol>
            </section>

            <section aria-labelledby="aa-faq-h" className="aa-block">
                <h2 id="aa-faq-h" className="aa-h">Questions</h2>
                <div className="aa-faq">
                    {FAQ.map(([q, a]) => (
                        <details key={q}>
                            <summary>{q}</summary>
                            <p>{a}</p>
                        </details>
                    ))}
                </div>
            </section>

            <div className="aa-sticky-cta">
                <Link to={cta.to} className="sys-tone-btn is-block" onClick={() => track(TRACK.CTA_CLICK, { id: cta.id, section: 'autoapply' })}>
                    {cta.label}
                </Link>
            </div>
        </>
    )
}

// ── After buying: the dashboard ─────────────────────────────────────
function ActivePack({ b, onAddMoney }) {
    const used = b.credits_used ?? 0
    const total = b.credits_total ?? b.pack_size ?? 0
    const left = Math.max(0, total - used)
    const live = b.live
    const busy = live && (live.phase === 'applying' || live.phase === 'starting')
    const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
    return (
        <section className={`aa-pack is-compact tone-${batchTone(b.status)}`} aria-label={packTitle(b)}>
            <div className="aa-compact">
                <h2 className="aa-compact-title">{packTitle(b)}</h2>
                <span className="aa-compact-num"><strong>{num(used)}/{num(total)}</strong></span>
                <span className="aa-compact-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={used} aria-label={`${num(used)} of ${num(total)} applied`}>
                    <span style={{ width: `${pct}%` }} />
                </span>
                <Link to={`/autoapply/batches/${b.id}`} className="sys-tone-btn is-sm aa-tone" aria-label={`View ${packTitle(b)}`}>View</Link>
            </div>
            <div className="aa-compact-meta">
                <BatchStatusPill status={b.status} />
                <span>{num(left)} left</span>
                {b.status === 'waiting_funds' && <button type="button" className="aa-btn" onClick={onAddMoney}>Add money</button>}
            </div>
            {live?.message && (
                <p className="aa-pack-msg is-compact">
                    {busy ? <span className="aa-flow-dot" aria-hidden="true" /> : <Radio size={13} aria-hidden="true" />}
                    <span className="t-ellipsis">{live.message}</span>
                </p>
            )}
        </section>
    )
}

/** Wallet card: balance, what is reserved for applications in flight, and the primary "Add money" button. */
function WalletCard({ wallet, onAdd, config }) {
    const bal = wallet.data?.balance_paise
    const held = wallet.data?.held_paise || 0
    const empty = bal != null && bal < (wallet.data?.min_start_paise ?? config?.wallet?.rate_paise?.product ?? 1800)
    return (
        <section className={`wl-card${empty ? ' is-empty' : ''}`} aria-label="Wallet">
            <div className="wl-top">
                <div>
                    <p className="wl-label"><Wallet size={14} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 6 }} />Wallet</p>
                    <p className="wl-bal" aria-live="polite">{bal == null ? (wallet.isError ? '—' : <span className="aa-skel" aria-label="Loading balance" />) : rupees(bal)}</p>
                    {held > 0 && <p className="wl-sub">{rupees(held)} reserved for applications in progress</p>}
                </div>
                <button type="button" className="sys-tone-btn wl-add" style={{ '--tone': 'var(--pop)' }} onClick={onAdd}>Add money</button>
            </div>
            <p className="wl-note">{PRICE_LINE(config)}</p>
        </section>
    )
}

/** A finished batch with credits left: remaining count + one tap to start again with a pre-filled batch. */
function RetriggerCard({ b }) {
    const r = b.retrigger
    const q = new URLSearchParams({ size: String(r.size), days: String(r.window_days), from: b.id })
    if (r.must_companies?.length) q.set('must', r.must_companies.join('|'))
    return (
        <section className="aa-pack is-compact tone-success" aria-label="Finished batch">
            <div className="aa-compact">
                <h2 className="aa-compact-title">{packTitle(b)}</h2>
                <span className="aa-compact-num"><strong>{num(b.credits_used)}/{num(b.credits_total)}</strong></span>
                <span className="aa-compact-bar" aria-hidden="true"><span style={{ width: `${b.credits_total ? Math.round((b.credits_used / b.credits_total) * 100) : 0}%` }} /></span>
                <Link to={`/autoapply/batches/${b.id}`} className="sys-tone-btn is-sm aa-tone">View</Link>
            </div>
            <div className="aa-compact-meta">
                <BatchStatusPill status={b.status} />
                <span>{num(r.remaining)} left unused, nothing charged for them</span>
            </div>
            <Link to={`/autoapply/buy?${q.toString()}`} className="sys-tone-btn is-block" style={{ '--tone': 'var(--pop)' }}>
                <RotateCcw size={15} aria-hidden="true" style={{ marginRight: 6 }} />Start again with remaining
            </Link>
        </section>
    )
}

function PastPacksSheet({ open, onClose, packs }) {
    return (
        <Sheet open={open} onClose={onClose} title="Past batches">
            {packs.length ? (
                <ul className="sys-rows">
                    {packs.map((b) => (
                        <li key={b.id}>
                            <Row title={packTitle(b)} sub={fmtDate(b.purchased_at || b.created_at, false)}
                                meta={`${num(b.credits_used ?? 0)} applied`} to={`/autoapply/batches/${b.id}`} />
                        </li>
                    ))}
                </ul>
            ) : <p className="aa-muted">No finished batches yet.</p>}
        </Sheet>
    )
}

function Dashboard({ batches, needCount, me, wallet, onAdd }) {
    const ivs = useInterviews()
    const unread = useInboxUnread()
    const [pastOpen, setPastOpen] = useState(false)
    const active = batches.filter((b) => ACTIVE_BATCH.includes(b.status))
    const past = batches.filter((b) => !ACTIVE_BATCH.includes(b.status))
    const applied = batches.reduce((n, b) => n + (Number(b.credits_used) || 0), 0)
    const { upcoming } = splitInterviews(ivs.data?.interviews || [])
    const unreadCount = unread.data?.count || 0
    const waitingProfile = active.find((b) => b.status === 'waiting_profile')
    const waitingFunds = active.find((b) => b.status === 'waiting_funds')
    const retrigger = batches.find((b) => b.status === 'finished_partial' && b.retrigger)
    const inReview = active.find((b) => b.status === 'review')

    // one status line at most: answers first, then a blocked profile, then a shortlist to check
    let banner = null
    if (waitingFunds) {
        const left = Math.max(0, (waitingFunds.credits_total ?? 0) - (waitingFunds.credits_used ?? 0))
        banner = <StatusBanner tone="action" text={`Wallet empty. Add money to continue (${num(left)} application${left === 1 ? '' : 's'} left in this batch).`} action={{ label: 'Add money', onClick: onAdd }} />
    } else if (needCount > 0) {
        banner = <StatusBanner tone="action" text={`${num(needCount)} question${needCount === 1 ? ' needs' : 's need'} your answer`} action={{ label: CTA.answerNow, to: '/autoapply/needs-you' }} />
    } else if (waitingProfile) {
        banner = <StatusBanner tone="warn" text="Finish your profile to start applying" action={{ label: 'Finish', to: setupLinkFor(waitingProfile.waiting_detail?.missing) }} />
    } else if (inReview) {
        banner = <StatusBanner tone="info" text="Your shortlist is ready to check" action={{ label: 'Review', to: `/autoapply/batches/${inReview.id}` }} />
    }

    return (
        <>
            <div className="aa-gap"><WalletCard wallet={wallet} onAdd={onAdd} config={me.data?.config} /></div>

            {banner && <div className="aa-gap">{banner}</div>}

            <ul className="sys-rows aa-gap">
                <li><Row className="wl-row-hl" leading={<Wallet size={20} />} title="Add money / Start a batch" sub={PRICE_LINE(me.data?.config)} to="/autoapply/buy" /></li>
            </ul>

            {active.length > 0 && <div className="aa-stack aa-gap">{active.map((b) => <ActivePack key={b.id} b={b} onAddMoney={onAdd} />)}</div>}
            {retrigger && <div className="aa-gap"><RetriggerCard b={retrigger} /></div>}

            <StatTiles cols={3} className="aa-gap" role="list" aria-label="Key numbers">
                <div role="listitem" style={{ display: 'grid' }}><StatTile icon={CheckCircle2} tone="success" label={TERMS.applied.one} value={applied} /></div>
                <div role="listitem" style={{ display: 'grid' }}><StatTile icon={CalendarCheck} tone="success" label="Interviews" value={upcoming.length} to="/autoapply/inbox?f=interview" /></div>
                <div role="listitem" style={{ display: 'grid' }}><StatTile icon={Hand} tone="attention" label={TERMS.answersNeeded.one} value={needCount} to={needCount ? '/autoapply/needs-you' : undefined} /></div>
            </StatTiles>

            <ul className="sys-rows">
                <li><Row leading={<Inbox size={20} />} title={TERMS.inbox.one} meta={unreadCount ? `${unreadCount > 99 ? '99+' : unreadCount} new` : undefined} metaTone="attention" to="/autoapply/inbox" /></li>
                <li><Row leading={<History size={20} />} title="Past batches" meta={past.length ? num(past.length) : undefined} onClick={() => setPastOpen(true)} /></li>
                <li><Row leading={<KeyRound size={20} />} title={TERMS.portalLogins.plural} to="/autoapply/account#sites" /></li>
                <li><Row leading={<BarChart3 size={20} />} title={TERMS.results.one} to="/autoapply/account#stats" /></li>
                <li><Row leading={<UserCog size={20} />} title="Your setup" to="/autoapply/account" /></li>
            </ul>
            <PastPacksSheet open={pastOpen} onClose={() => setPastOpen(false)} packs={past} />
            {me.data?.is_admin && <p style={{ marginTop: 20 }}><Link to="/autoapply/admin/health" className="aa-faint">Health</Link></p>}
        </>
    )
}

export default function AutoApplyLanding() {
    const me = useAutoApplyMe()
    const live = useAutoApplyRealtime()
    const batchesQ = useBatches({ live })
    const wallet = useWallet()
    const [topup, setTopup] = useState(false)
    const batches = batchesQ.data?.batches || []
    const bought = batches.length > 0
    const needs = useNeedsYou({ enabled: bought })
    const needCount = bought ? ((needs.data?.unique_count ?? needs.data?.items?.length) || 0) : 0
    const loading = me.isLoading || batchesQ.isLoading
    const active = batches.filter((b) => ACTIVE_BATCH.includes(b.status))
    const subtitle = bought
        ? (active.length ? `${num(active.length)} ${active.length === 1 ? 'batch is' : 'batches are'} running` : 'No batch running right now')
        : undefined

    return (
        <AALayout>
            <PageHeader
                section="autoapply"
                title="We apply for you"
                subtitle={subtitle}
                aside={<HelpChip term="pack" />}
            />
            {loading ? (
                <LoadingState label="Loading…" />
            ) : me.isError ? (
                <ErrorState compact err={me.error} onRetry={() => me.refetch()} />
            ) : batchesQ.isError ? (
                <ErrorState compact err={batchesQ.error} onRetry={() => batchesQ.refetch()} />
            ) : bought ? (
                <Dashboard batches={batches} needCount={needCount} me={me} wallet={wallet} onAdd={() => setTopup(true)} />
            ) : (
                <SalesScreen me={me} />
            )}
            <WalletTopUp open={topup} onClose={() => setTopup(false)} wallet={wallet.data} />
        </AALayout>
    )
}

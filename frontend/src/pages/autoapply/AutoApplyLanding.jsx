import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BarChart3, CalendarCheck, CheckCircle2, Hand, History, Inbox, KeyRound, Radio, ShoppingBag, UserCog } from 'lucide-react'
import { ErrorState, LoadingState } from '../../components/shared/states'
import { HelpChip, PageHeader, Progress, Row, Sheet, StatTile, StatTiles, StatusBanner } from '../../components/ui'
import { CTA, TERMS } from '../../lib/copy'
import { track, TRACK } from '../../lib/track'
import {
    useAutoApplyMe, useAutoApplyRealtime, useBatches, useInboxUnread, useInterviews, useNeedsYou, useSupply,
} from '../../lib/useAutoApply'
import { splitInterviews } from './InterviewsPanel'
import {
    AALayout, ACTIVE_BATCH, BatchStatusPill, PACK_KINDS, PACK_SIZES, SETUP_ORDER, batchTone, fmtDate, matchShown, num,
    packPrice, packTitle, perApplication, readSetupStep, setupLinkFor,
} from './ui'

// ── Not bought yet: the sales screen ────────────────────────────────
const HOW = ['Tell us the job you want', 'Pick a pack and pay', 'We apply to matching jobs', 'Replies land in your inbox']
const FAQ = [
    ['Do you apply with my resume?', 'Yes. We fill each form with your resume and your saved answers.'],
    ['What if a form asks something new?', 'We ask you once under Answers needed. Then we keep applying.'],
    ['Can I stop a pack?', 'Yes. Pause it any time. Applications you have not used stay saved.'],
]

function cheapestPerApp(config) {
    let best = null
    for (const kind of Object.keys(PACK_KINDS)) {
        for (const size of PACK_SIZES) {
            const p = packPrice(config, kind, size)
            if (p != null && (best == null || p / size < best.v)) best = { v: p / size, p, size }
        }
    }
    return best ? perApplication(best.p, best.size) : null
}

// Live count from GET /supply (same broadening ladder as the buy page), the larger of the two pack kinds.
function MatchCount({ config }) {
    const wd = config?.window_days_default ?? 30
    const sv = useSupply('service', wd, 50)
    const pr = useSupply('product', wd, 50)
    const loading = sv.isLoading || pr.isLoading
    const failed = sv.isError && pr.isError
    const count = Math.max(sv.data?.count || 0, pr.data?.count || 0)
    const per = cheapestPerApp(config)
    if (failed) return null
    return (
        <section className="aa-hero" aria-label="Matching jobs" aria-busy={loading}>
            <p className="aa-hero-count" aria-live="polite">
                {loading ? <span className="aa-skel" aria-label="Counting matching jobs" /> : <strong>{matchShown(count, 50)}</strong>}
                <span>jobs match you</span>
                <HelpChip term="matchCount" />
            </p>
            {per && <p className="aa-hero-sub">From {per} per application</p>}
        </section>
    )
}

function SalesScreen({ me }) {
    const data = me.data || {}
    const saved = readSetupStep()
    const k = saved ? SETUP_ORDER.indexOf(saved) + 1 : 0
    const cta = data.onboarding_done
        ? { label: CTA.seePacks, to: '/autoapply/buy', id: 'see_packs' }
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
function ActivePack({ b }) {
    const used = b.credits_used ?? 0
    const total = b.credits_total ?? b.pack_size ?? 0
    const live = b.live
    const busy = live && (live.phase === 'applying' || live.phase === 'starting')
    return (
        <section className={`aa-pack tone-${batchTone(b.status)}`} aria-label={packTitle(b)}>
            <div className="aa-pack-top">
                <h2 className="aa-pack-title">{packTitle(b)}</h2>
                <BatchStatusPill status={b.status} />
            </div>
            <Progress value={used} max={total} label={`${num(used)} of ${num(total)} applied`} showText={false} />
            <div className="aa-pack-foot">
                <span className="aa-pack-num"><strong>{num(used)} / {num(total)}</strong> applied</span>
                <Link to={`/autoapply/batches/${b.id}`} className="sys-tone-btn is-sm aa-tone" aria-label={`View ${packTitle(b)}`}>View</Link>
            </div>
            {live?.message && (
                <p className="aa-pack-msg">
                    {busy ? <span className="aa-flow-dot" aria-hidden="true" /> : <Radio size={13} aria-hidden="true" />}
                    <span className="t-ellipsis">{live.message}</span>
                </p>
            )}
        </section>
    )
}

function PastPacksSheet({ open, onClose, packs }) {
    return (
        <Sheet open={open} onClose={onClose} title={`Past ${TERMS.pack.plural.toLowerCase()}`}>
            {packs.length ? (
                <ul className="sys-rows">
                    {packs.map((b) => (
                        <li key={b.id}>
                            <Row title={packTitle(b)} sub={fmtDate(b.purchased_at || b.created_at, false)}
                                meta={`${num(b.credits_used ?? 0)} applied`} to={`/autoapply/batches/${b.id}`} />
                        </li>
                    ))}
                </ul>
            ) : <p className="aa-muted">No finished packs yet.</p>}
        </Sheet>
    )
}

function Dashboard({ batches, needCount, me }) {
    const ivs = useInterviews()
    const unread = useInboxUnread()
    const [pastOpen, setPastOpen] = useState(false)
    const active = batches.filter((b) => ACTIVE_BATCH.includes(b.status))
    const past = batches.filter((b) => !ACTIVE_BATCH.includes(b.status))
    const applied = batches.reduce((n, b) => n + (Number(b.credits_used) || 0), 0)
    const { upcoming } = splitInterviews(ivs.data?.interviews || [])
    const unreadCount = unread.data?.count || 0
    const waitingProfile = active.find((b) => b.status === 'waiting_profile')
    const inReview = active.find((b) => b.status === 'review')

    // one status line at most: answers first, then a blocked profile, then a shortlist to check
    let banner = null
    if (needCount > 0) {
        banner = <StatusBanner tone="action" text={`${num(needCount)} question${needCount === 1 ? ' needs' : 's need'} your answer`} action={{ label: CTA.answerNow, to: '/autoapply/needs-you' }} />
    } else if (waitingProfile) {
        banner = <StatusBanner tone="warn" text="Finish your profile to start applying" action={{ label: 'Finish', to: setupLinkFor(waitingProfile.waiting_detail?.missing) }} />
    } else if (inReview) {
        banner = <StatusBanner tone="info" text="Your shortlist is ready to check" action={{ label: 'Review', to: `/autoapply/batches/${inReview.id}` }} />
    }

    return (
        <>
            {banner && <div className="aa-gap">{banner}</div>}

            {active.length > 0 && <div className="aa-stack aa-gap">{active.map((b) => <ActivePack key={b.id} b={b} />)}</div>}

            <StatTiles cols={3} className="aa-gap" role="list" aria-label="Key numbers">
                <div role="listitem" style={{ display: 'grid' }}><StatTile icon={CheckCircle2} tone="success" label={TERMS.applied.one} value={applied} /></div>
                <div role="listitem" style={{ display: 'grid' }}><StatTile icon={CalendarCheck} tone="success" label="Interviews" value={upcoming.length} to="/autoapply/inbox?f=interview" /></div>
                <div role="listitem" style={{ display: 'grid' }}><StatTile icon={Hand} tone="attention" label={TERMS.answersNeeded.one} value={needCount} to={needCount ? '/autoapply/needs-you' : undefined} /></div>
            </StatTiles>

            <ul className="sys-rows">
                <li><Row leading={<Inbox size={20} />} title={TERMS.inbox.one} meta={unreadCount ? `${unreadCount > 99 ? '99+' : unreadCount} new` : undefined} metaTone="attention" to="/autoapply/inbox" /></li>
                <li><Row leading={<History size={20} />} title={`Past ${TERMS.pack.plural.toLowerCase()}`} meta={past.length ? num(past.length) : undefined} onClick={() => setPastOpen(true)} /></li>
                <li><Row leading={<KeyRound size={20} />} title={TERMS.portalLogins.plural} to="/autoapply/account#sites" /></li>
                <li><Row leading={<BarChart3 size={20} />} title={TERMS.results.one} to="/autoapply/account#stats" /></li>
                <li><Row leading={<UserCog size={20} />} title="Your setup" to="/autoapply/account" /></li>
                <li><Row leading={<ShoppingBag size={20} />} title={active.length ? 'Buy another pack' : 'Buy a pack'} to="/autoapply/buy" /></li>
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
    const batches = batchesQ.data?.batches || []
    const bought = batches.length > 0
    const needs = useNeedsYou({ enabled: bought })
    const needCount = bought ? (needs.data?.items?.length || 0) : 0
    const loading = me.isLoading || batchesQ.isLoading
    const active = batches.filter((b) => ACTIVE_BATCH.includes(b.status))
    const subtitle = bought
        ? (active.length ? `${num(active.length)} ${active.length === 1 ? 'pack is' : 'packs are'} running` : 'No pack running right now')
        : undefined

    return (
        <AALayout>
            <PageHeader
                section="autoapply"
                title="We apply for you"
                subtitle={subtitle}
                aside={<HelpChip term="pack" />}
                action={bought && !active.length ? { label: CTA.seePacks, to: '/autoapply/buy' } : undefined}
            />
            {loading ? (
                <LoadingState label="Loading…" />
            ) : me.isError ? (
                <ErrorState compact err={me.error} onRetry={() => me.refetch()} />
            ) : batchesQ.isError ? (
                <ErrorState compact err={batchesQ.error} onRetry={() => batchesQ.refetch()} />
            ) : bought ? (
                <Dashboard batches={batches} needCount={needCount} me={me} />
            ) : (
                <SalesScreen me={me} />
            )}
        </AALayout>
    )
}

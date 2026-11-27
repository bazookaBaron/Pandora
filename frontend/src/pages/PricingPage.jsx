import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import Navbar from '../components/Navbar'
import { TIERS, PLAN_ORDER, priceInrPaise, priceUsdCents } from '../../config/tiers.js'
import { useEntitlements } from '../lib/useEntitlements'
import { useGeoCurrency } from '../lib/useGeoCurrency'
import { useAuth } from '../contexts/AuthContext'
import { ErrorState } from '../components/shared/states'
import { PageContainer } from '../components/shared/Layout'
import { track, EVENTS } from '../lib/analytics'
import { track as trackUi, TRACK } from '../lib/track'
import { startCheckout as startRazorpayCheckoutFlow } from '../lib/razorpay'
import { apiFetch } from '../lib/apiClient'
import { useAutoApplyMe } from '../lib/useAutoApply'
import { PACK_SIZES, packPrice } from './autoapply/ui'
import { Check, Minus, Zap } from 'lucide-react'
import { AUTOAPPLY_ENABLED } from '../lib/sections'
import { TERMS } from '../lib/copy'
import { Segmented, Pill, Button, PageHeader, Row, Sheet } from '../components/ui'

// ── Plans (config-driven from config/tiers.js) ──────────────────────
// Pro and Max are recurring Razorpay subscriptions: billed monthly or yearly,
// renewed automatically until cancelled. Cancelling keeps access until the end
// of the paid period. The page never renders a price until the currency is
// known (skeleton), so INR never flashes before USD.

const PLAN_META = {
    free: { name: 'Free', tagline: 'Try every feature', cta: 'Free forever' },
    pro: { name: 'Pro', tagline: 'Everything you need to prep', badge: 'Most popular', cta: 'Get Pro', highlights: ['jobs', 'referrals', 'optimizer'] },
    max: { name: 'Max', tagline: 'No limits, for daily prep', cta: 'Get Max', highlights: ['hld', 'referrals', 'optimizer'] },
}

const FAQ = [
    ['Does my plan renew automatically?', 'Yes. Pro and Max renew every month or year until you cancel. You can cancel anytime from this page and keep access until the end of the period you paid for.'],
    ['What if a payment fails?', 'You keep access for 3 days while we retry. If it still fails, you return to Free. Nothing else is charged.'],
    ['Can I switch between Pro and Max?', 'Yes. The switch takes effect at your next renewal, on the same billing period.'],
    ['Is there a free plan?', 'Yes. Free gives you some of every feature, forever.'],
]
const PAYMENT_FAQ = {
    INR: ['Which payment methods work?', 'Indian cards, UPI and net banking, through Razorpay.'],
    USD: ['Which payment methods work?', 'International cards, through Razorpay.'],
}

const isInf = (v) => v === Infinity || v === 'unlimited'
const rupees = (paise) => `₹${Math.round((paise || 0) / 100).toLocaleString('en-IN')}`
const dollars = (cents) => `$${((cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const priceOf = (plan, period, currency) => (currency === 'USD' ? priceUsdCents(plan, period) : priceInrPaise(plan, period))
const money = (amount, currency) => (currency === 'USD' ? dollars(amount) : rupees(amount))
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '')
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '')

// ── Feature rows: ONE source for the card highlights and the table ──
// kind 'access' renders the catalogue access flag; otherwise the numeric limit.
const lowerTerm = (t) => t.one.toLowerCase()
const FEATURES = [
    { key: 'dsa', group: 'Practice', label: 'DSA problems', limitKey: 'dsa_catalog_visible', card: (v) => (isInf(v) ? 'All DSA problems' : `${v} DSA problems`) },
    { key: 'lld', group: 'Practice', label: `${TERMS.lld.one} problems`, limitKey: 'lld_catalog_visible', card: (v) => (isInf(v) ? `All ${lowerTerm(TERMS.lld)} problems` : `${v} ${lowerTerm(TERMS.lld)} problems`) },
    { key: 'hldBrowse', group: 'Practice', label: `${TERMS.hld.one} catalogue`, limitKey: 'hld_catalog_access', kind: 'access' },
    { key: 'hld', group: 'Practice', label: `${TERMS.hld.one} practice / month`, limitKey: 'hld_practice_per_month', card: (v) => (isInf(v) ? `Unlimited ${lowerTerm(TERMS.hld)} practice` : `${v} ${lowerTerm(TERMS.hld)} practices / mo`) },
    { key: 'interview', group: 'Practice', label: 'Interview questions per topic', limitKey: 'interview_q_per_subcategory', card: (v) => (isInf(v) ? 'All interview questions' : `${v} interview questions / topic`) },
    { key: 'jobs', group: 'Jobs and referrals', label: 'Job listings', limitKey: 'jobs_visible', card: (v) => (isInf(v) ? 'All job listings' : `${v} job listings`) },
    { key: 'jobAlerts', group: 'Jobs and referrals', label: 'Company job alerts', limitKey: 'company_subscriptions_max', card: (v) => `${v} company job alert${v === 1 ? '' : 's'}` },
    { key: 'referrals', group: 'Jobs and referrals', label: 'Referral requests / month', limitKey: 'referral_requests_per_month', card: (v) => (isInf(v) ? 'Unlimited referral requests' : `${v} referral requests / mo`) },
    { key: 'optimizer', group: 'Resume and AI', label: 'Resume checks / month', limitKey: 'resume_optimizer_per_month', card: (v) => (isInf(v) ? 'Unlimited resume checks' : `${v} resume checks / mo`) },
    { key: 'ai', group: 'Resume and AI', label: 'AI explanations / month', limitKey: 'ai_explanations_per_month', card: (v) => `${v} AI explanations / mo` },
]

// { text, on, check?, partial? } for one table cell.
function cellFor(planId, f) {
    const v = (TIERS[planId] || TIERS.free).limits[f.limitKey]
    if (f.kind === 'access') return v === 'full' ? { text: 'Full', on: true, check: true } : { text: 'Browse only', on: false, partial: true }
    if (isInf(v)) return { text: 'Unlimited', on: true }
    if (!v) return { text: 'Not included', on: false }
    return { text: v.toLocaleString('en-US'), on: true }
}

function highlightsFor(planId) {
    const limits = (TIERS[planId] || TIERS.free).limits
    return (PLAN_META[planId].highlights || [])
        .map((k) => FEATURES.find((f) => f.key === k))
        .filter(Boolean)
        .map((f) => ({ key: f.key, label: f.card(limits[f.limitKey]) }))
}

function Price({ ready, children }) {
    if (!ready) return <span className="pt-skel" role="status" aria-label="Loading price" />
    return <>{children}</>
}

// ── One plan card ────────────────────────────────────────────────────
function PlanCard({ id, billing, currency, ready, isCurrent, status, onSubscribe, onSwitch, pending, signedIn, sub }) {
    const meta = PLAN_META[id]
    const isFree = id === 'free'
    const featured = id === 'pro'
    const monthly = priceOf(id, 'monthly', currency)
    const yearly = priceOf(id, 'yearly', currency)
    const headline = billing === 'yearly' ? yearly / 12 : monthly
    const comingSoon = !isFree && status && !status.configured
    const canSwitch = !isFree && !isCurrent && !!sub?.recurring && !sub.cancel_at_period_end && !sub.pending_plan && sub.plan !== 'free'

    let cta
    if (isFree) {
        cta = <Button variant="secondary" size="lg" block disabled>{isCurrent ? 'Current plan' : meta.cta}</Button>
    } else if (isCurrent) {
        cta = <Button variant="secondary" size="lg" block disabled>Current plan</Button>
    } else if (comingSoon) {
        cta = <Button variant="secondary" size="lg" block disabled>Coming soon</Button>
    } else if (canSwitch) {
        cta = <Button variant="secondary" size="lg" block onClick={() => onSwitch(id)}>Switch to {meta.name}</Button>
    } else if (sub && sub.plan !== 'free') {
        // Legacy term, coupon or already cancelling: subscribe once it ends.
        cta = <Button variant="secondary" size="lg" block disabled>After your current plan ends</Button>
    } else {
        cta = (
            <Button
                variant={featured ? 'upgrade' : 'primary'}
                size="lg"
                block
                onClick={() => onSubscribe(id)}
                disabled={!ready || !!pending}
                busy={pending === id}
                busyLabel="Opening checkout"
            >
                {signedIn ? meta.cta : `Sign in to get ${meta.name}`}
            </Button>
        )
    }

    return (
        <article className={`pt-card${featured ? ' is-featured' : ''}${isCurrent ? ' is-current' : ''}`} aria-label={`${meta.name} plan`}>
            <div className="pt-card-head">
                <h2 className="pt-name">{meta.name}</h2>
                {isCurrent ? <Pill tone="active" soft>Current</Pill> : meta.badge && <Pill tone="active" soft>{meta.badge}</Pill>}
            </div>
            <p className="pt-tagline">{meta.tagline}</p>

            <div className="pt-price">
                {isFree ? (
                    <Price ready={ready}><span className="pt-amount">{currency === 'USD' ? '$0' : '₹0'}</span></Price>
                ) : (
                    <Price ready={ready}><span className="pt-amount">{money(headline, currency)}</span></Price>
                )}
                <span className="pt-per">/mo</span>
            </div>
            <p className="pt-billed">
                {isFree
                    ? 'No card needed'
                    : <Price ready={ready}>{billing === 'yearly' ? `${money(yearly, currency)} billed yearly` : 'Billed monthly'}</Price>}
            </p>

            <ul className="pt-list">
                {(isFree ? [{ key: 'free', label: 'Some of every feature' }] : highlightsFor(id)).map((h) => (
                    <li key={h.key}><Check size={15} aria-hidden="true" /><span>{h.label}</span></li>
                ))}
            </ul>

            <div className="pt-cta">{cta}</div>
        </article>
    )
}

// ── Current plan panel: renewal date, status, manage / cancel ────────
function CurrentPlanPanel({ sub, onManage }) {
    const name = cap(sub.plan)
    const end = fmtDate(sub.current_period_end)
    let status
    let line
    if (sub.status === 'past_due') {
        status = <Pill tone="attention" soft>Payment failed</Pill>
        line = `Your last payment did not go through. Access continues until ${fmtDate(sub.grace_until) || end}, then you move to Free unless a retry succeeds.`
    } else if (sub.cancel_at_period_end) {
        status = <Pill tone="attention" soft>Ends {end}</Pill>
        line = `Cancelled. You keep ${name} until ${end}, then you move to Free. You will not be charged again.`
    } else if (sub.recurring) {
        status = <Pill tone="success" soft>Active</Pill>
        line = `Renews automatically on ${end}${sub.billing_period ? ` (${sub.billing_period})` : ''}.`
        if (sub.pending_plan) line += ` Switching to ${cap(sub.pending_plan)} at that renewal.`
    } else {
        status = <Pill tone="history" soft>Fixed term</Pill>
        line = `${name} runs until ${end} and will not renew. After that you can subscribe again.`
    }
    return (
        <section className="pt-current" aria-label="Your plan">
            <div className="pt-current-main">
                <div className="pt-current-title">
                    <h2 className="pt-current-name">{name} plan</h2>
                    {status}
                </div>
                <p className="pt-current-line">{line}</p>
            </div>
            {sub.can_cancel && (
                <button type="button" className="pt-link" onClick={onManage}>Manage plan / Cancel</button>
            )}
        </section>
    )
}

// Auto Apply packs (prices come from GET /api/autoapply/me -> config.packs): one row.
function AutoApplyRow({ currentPlan }) {
    const me = useAutoApplyMe()
    const config = me.data?.config
    const eligible = me.data ? !!me.data.eligible : currentPlan === 'pro' || currentPlan === 'max'
    const prices = ['service', 'product']
        .flatMap((kind) => PACK_SIZES.map((size) => packPrice(config, kind, size)))
        .filter((p) => p != null)
    const from = prices.length ? Math.min(...prices) : null
    return (
        <ul className="sys-rows pt-aa" aria-label="Add-ons">
            <li>
                <Row
                    leading={<Zap size={18} aria-hidden="true" />}
                    tone="var(--pop)"
                    title={`Auto Apply ${TERMS.pack.plural.toLowerCase()}`}
                    sub={from != null ? `From ${rupees(from)} · needs Pro or Max` : 'Needs Pro or Max'}
                    to={eligible ? '/autoapply/buy' : '/autoapply'}
                />
            </li>
        </ul>
    )
}

// ── Comparison table: grouped rows x Free/Pro/Max, sticky header ─────
function CompareTable() {
    const groups = useMemo(() => {
        const out = []
        for (const f of FEATURES) {
            let g = out.find((x) => x.name === f.group)
            if (!g) { g = { name: f.group, rows: [] }; out.push(g) }
            g.rows.push(f)
        }
        if (AUTOAPPLY_ENABLED) {
            out.push({ name: 'Add-ons', rows: [{ key: 'aa', label: `Auto Apply ${TERMS.pack.plural.toLowerCase()}`, addon: true }] })
        }
        return out
    }, [])

    return (
        <section className="pt-compare" aria-labelledby="pt-compare-h">
            <h2 id="pt-compare-h" className="pt-h2">Compare plans</h2>
            <div className="pt-scroll" role="region" aria-label="Plan comparison table" tabIndex={0}>
                <table className="pt-table">
                    <thead>
                        <tr>
                            <th scope="col" className="pt-feature-col"><span className="sys-sr">Feature</span></th>
                            {PLAN_ORDER.map((id) => (
                                <th key={id} scope="col" className={id === 'pro' ? 'is-featured' : ''}>{PLAN_META[id].name}</th>
                            ))}
                        </tr>
                    </thead>
                    {groups.map((g) => (
                        <tbody key={g.name}>
                            <tr className="pt-group"><th scope="colgroup" colSpan={PLAN_ORDER.length + 1}>{g.name}</th></tr>
                            {g.rows.map((f) => (
                                <tr key={f.key}>
                                    <th scope="row" className="pt-feature-col">{f.label}</th>
                                    {PLAN_ORDER.map((id) => {
                                        const c = f.addon
                                            ? { text: id === 'free' ? 'Not included' : 'Available', on: id !== 'free' }
                                            : cellFor(id, f)
                                        let body
                                        if (c.check) body = <><Check size={16} aria-hidden="true" /><span className="sys-sr">Included</span></>
                                        else if (c.on || c.partial) body = c.text
                                        else body = <><Minus size={16} aria-hidden="true" /><span className="sys-sr">Not included</span></>
                                        return (
                                            <td key={id} className={`${c.on ? 'is-on' : 'is-off'}${id === 'pro' ? ' is-featured' : ''}`}>{body}</td>
                                        )
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    ))}
                </table>
            </div>
        </section>
    )
}

export default function PricingPage() {
    const { plan: currentPlan, subscription: sub, refetch, isLoading: entLoading } = useEntitlements()
    const { currency, ready: currencyReady } = useGeoCurrency()
    const { user } = useAuth()
    const navigate = useNavigate()
    const [billing, setBilling] = useState('monthly') // 'monthly' | 'yearly'
    const [note, setNote] = useState('')
    const [pending, setPending] = useState('')
    const [sheet, setSheet] = useState(null) // null | 'coupon' | 'manage' | { switchTo: 'pro'|'max' }
    const [busy, setBusy] = useState(false)
    const [manageMsg, setManageMsg] = useState(null)

    // Billing availability (kill switch + this user's currency plan ids).
    const statusQ = useQuery({
        queryKey: ['subscriptions-status', user?.id ?? null],
        queryFn: () => apiFetch('/api/subscriptions/status'),
        enabled: !!user,
        staleTime: 60_000,
        retry: 1,
    })
    const status = user ? statusQ.data : null
    // Prices wait for the currency; the signed-in state also waits for its plan.
    const ready = currencyReady && (!user || !entLoading)

    useEffect(() => { track(EVENTS.PRICING_VIEWED) }, [])

    const savingsPct = useMemo(() => {
        const pcts = ['pro', 'max'].map((p) => {
            const m = priceOf(p, 'monthly', currency)
            const y = priceOf(p, 'yearly', currency)
            return m && y ? Math.round((1 - y / (m * 12)) * 100) : 0
        })
        return Math.max(...pcts)
    }, [currency])

    async function subscribe(plan) {
        if (!user) { navigate('/auth'); return }
        setNote('')
        setPending(plan)
        track(EVENTS.CHECKOUT_STARTED, { plan, billing })
        try {
            const r = await startRazorpayCheckoutFlow({ plan, billingPeriod: billing, user })
            track(EVENTS.CHECKOUT_COMPLETED, { plan, billing })
            refetch()
            navigate(r && r.processing ? '/subscription/success?pending=1' : '/subscription/success')
        } catch (err) {
            if (err?.code === 'dismissed') {
                // user closed the modal, nothing to say
            } else if (err?.code === 'unconfigured') {
                setNote('Subscriptions are not available yet. Please check back soon.')
            } else if (err?.code === 'already') {
                setNote('You already have a plan or a payment in progress. Reload the page to see it.')
                refetch()
            } else {
                setNote(err?.message || 'Could not complete the payment.')
            }
        } finally {
            setPending('')
        }
    }

    async function cancelPlan() {
        setBusy(true)
        setManageMsg(null)
        try {
            await apiFetch('/api/subscriptions/cancel', { method: 'POST', json: {} })
            await refetch()
            setSheet(null)
        } catch (err) {
            setManageMsg({ ok: false, text: err?.body?.message || 'Could not cancel right now. Please try again.' })
        } finally {
            setBusy(false)
        }
    }

    async function switchPlan(plan) {
        setBusy(true)
        setManageMsg(null)
        try {
            await apiFetch('/api/subscriptions/change', { method: 'POST', json: { plan } })
            await refetch()
            setSheet(null)
        } catch (err) {
            setManageMsg({ ok: false, text: err?.body?.message || 'Could not switch plans right now.' })
        } finally {
            setBusy(false)
        }
    }

    const [couponCode, setCouponCode] = useState('')
    const [couponBusy, setCouponBusy] = useState(false)
    const [couponMsg, setCouponMsg] = useState(null)

    async function redeemPlanCoupon() {
        if (!user) { setCouponMsg({ ok: false, text: 'Please sign in first.' }); return }
        const code = couponCode.trim().toUpperCase()
        if (!code) return
        setCouponBusy(true)
        setCouponMsg(null)
        try {
            const r = await apiFetch('/api/payments/coupon', { json: { code, billingPeriod: billing } })
            refetch()
            setCouponMsg({ ok: true, text: `${r.plan === 'max' ? 'Max' : 'Pro'} plan is active until ${fmtDate(r.current_period_end)}.` })
        } catch (err) {
            setCouponMsg({ ok: false, text: err?.body?.message || err?.message || 'Could not apply the coupon.' })
        } finally {
            setCouponBusy(false)
        }
    }

    const closeSheet = () => { setSheet(null); setManageMsg(null) }
    const switchTo = sheet && typeof sheet === 'object' ? sheet.switchTo : null
    const endDate = fmtDate(sub?.current_period_end)
    const renewal = billing === 'yearly'
        ? 'Billed yearly, cancel anytime. Renews automatically every year.'
        : 'Billed monthly, cancel anytime. Renews automatically every month.'

    return (
        <>
            <Navbar />
            {pending && (
                <div className="pricing-overlay" aria-live="polite">
                    <div>
                        <span className="spinner-lg" />
                        <span>Opening secure checkout…</span>
                    </div>
                </div>
            )}
            <PageContainer width="lg" className="pt-wrap">
                <PageHeader section="me" title="Plans" subtitle="Renews automatically. Cancel anytime." />

                {user && sub && <CurrentPlanPanel sub={sub} onManage={() => setSheet('manage')} />}

                <div className="pt-controls">
                    <Segmented label="Billing period" value={billing} onChange={setBilling}
                        options={[{ value: 'monthly', label: 'Monthly' }, { value: 'yearly', label: 'Yearly' }]} />
                    {savingsPct > 0 && <span className="pt-save">Yearly saves {savingsPct}%</span>}
                </div>

                <div className="pt-grid">
                    {PLAN_ORDER.map((id) => (
                        <PlanCard
                            key={id}
                            id={id}
                            billing={billing}
                            currency={currency}
                            ready={ready}
                            isCurrent={currentPlan === id}
                            status={status}
                            sub={sub}
                            signedIn={!!user}
                            pending={pending}
                            onSubscribe={(p) => { trackUi(TRACK.CTA_CLICK, { id: `pricing_${p}`, section: 'me' }); subscribe(p) }}
                            onSwitch={(p) => setSheet({ switchTo: p })}
                        />
                    ))}
                </div>

                <p className="pt-renewal">{renewal}</p>
                {note && <ErrorState compact title="Checkout" message={note} />}

                <div className="pt-links">
                    <button type="button" className="pt-link" onClick={() => setSheet('coupon')}>Have a code?</button>
                </div>

                <CompareTable />

                {AUTOAPPLY_ENABLED && <AutoApplyRow currentPlan={currentPlan} />}

                <section className="pt-faq prose" aria-labelledby="pt-faq-h">
                    <h2 id="pt-faq-h" className="pt-h2">Questions</h2>
                    {[...FAQ, PAYMENT_FAQ[currency] || PAYMENT_FAQ.INR].map(([q, a]) => (
                        <details key={q}>
                            <summary>{q}</summary>
                            <p>{a}</p>
                        </details>
                    ))}
                </section>

                <p className="pt-fine">
                    {ready ? `Prices in ${currency}. ` : ''}Secure checkout by Razorpay. Cancel before the renewal date to avoid the next charge.
                </p>
            </PageContainer>

            {/* Manage / cancel: the confirm shows the end date */}
            <Sheet
                open={sheet === 'manage'}
                onClose={closeSheet}
                title="Manage plan"
                description={sub ? `${cap(sub.plan)} plan, ${sub.billing_period || 'recurring'}` : undefined}
            >
                <div className="pt-manage">
                    <p>
                        If you cancel, you keep <strong>{cap(sub?.plan)}</strong> until <strong>{endDate}</strong>. After that you move to Free and
                        are not charged again. You can subscribe again anytime.
                    </p>
                    {manageMsg && <p role="alert" className="pt-msg is-err">{manageMsg.text}</p>}
                    <Button variant="danger" size="lg" block onClick={cancelPlan} busy={busy} busyLabel="Cancelling">
                        Cancel at end of period ({endDate})
                    </Button>
                    <Button variant="secondary" size="lg" block onClick={closeSheet} disabled={busy}>Keep my plan</Button>
                </div>
            </Sheet>

            {/* Pro <-> Max */}
            <Sheet open={!!switchTo} onClose={closeSheet} title={switchTo ? `Switch to ${cap(switchTo)}` : 'Switch plan'}>
                <div className="pt-manage">
                    <p>
                        Your plan changes to <strong>{cap(switchTo)}</strong> at your next renewal on <strong>{endDate}</strong>, on the same billing period.
                        Until then you keep {cap(sub?.plan)}.
                    </p>
                    {manageMsg && <p role="alert" className="pt-msg is-err">{manageMsg.text}</p>}
                    <Button variant="primary" size="lg" block onClick={() => switchPlan(switchTo)} busy={busy} busyLabel="Scheduling">
                        Switch at renewal
                    </Button>
                    <Button variant="secondary" size="lg" block onClick={closeSheet} disabled={busy}>Not now</Button>
                </div>
            </Sheet>

            <Sheet open={sheet === 'coupon'} onClose={closeSheet} title="Have a code?" description="Enter your coupon to unlock a plan.">
                <form onSubmit={(e) => { e.preventDefault(); redeemPlanCoupon() }} className="pt-coupon">
                    <label htmlFor="plan-coupon" className="sys-field-label">Coupon code</label>
                    <input id="plan-coupon" className="input-field" placeholder="e.g. WELCOME" maxLength={40} value={couponCode}
                        autoComplete="off" autoCapitalize="characters"
                        onChange={(e) => { setCouponCode(e.target.value); setCouponMsg(null) }}
                        disabled={couponBusy} />
                    <Button type="submit" variant="primary" size="lg" block disabled={!couponCode.trim()} busy={couponBusy} busyLabel="Applying…">Apply code</Button>
                    {couponMsg && (
                        <p role="status" className={`pt-msg ${couponMsg.ok ? 'is-ok' : 'is-err'}`}>{couponMsg.text}</p>
                    )}
                </form>
            </Sheet>
        </>
    )
}

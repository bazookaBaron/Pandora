import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { TIERS, PLAN_ORDER, priceInrPaise, priceUsdCents } from '../../config/tiers.js'
import { useEntitlements } from '../lib/useEntitlements'
import { useAuth } from '../contexts/AuthContext'
import { ErrorState } from '../components/shared/states'
import { PageContainer } from '../components/shared/Layout'
import { track, EVENTS } from '../lib/analytics'
import { track as trackUi, TRACK } from '../lib/track'
import { startCheckout as startRazorpayCheckoutFlow } from '../lib/razorpay'
import { apiFetch } from '../lib/apiClient'
import { useAutoApplyMe } from '../lib/useAutoApply'
import { PACK_SIZES, packPrice } from './autoapply/ui'
import { Check, X, Zap } from 'lucide-react'
import { PLAN_TONE } from '../lib/brand'
import { AUTOAPPLY_ENABLED } from '../lib/sections'
import { TERMS } from '../lib/copy'
import { Segmented, Pill, Button, PageHeader, Row, Sheet } from '../components/ui'

// ── Pricing (config-driven, plan §4.6) ──────────────────────────────
// Two stacked plan cards (Pro, Max) straight from `config/tiers.js`, 3 benefits
// and one CTA each. Everything else (Free, the full feature list, coupon) sits
// in sheets. The CTAs open Razorpay Standard Checkout (one-time payment for a
// monthly / yearly term); on a verified payment we re-poll entitlements.

const PAID_PLANS = PLAN_ORDER.filter((id) => id !== 'free')

const PLAN_META = {
    free: { name: 'Free', tagline: 'Try every feature', cta: 'Start free' },
    pro: { name: 'Pro', tagline: 'Everything you need to prep', badge: 'Most popular', cta: 'Get Pro', benefits: ['jobs', 'referrals', 'optimizer'] },
    max: { name: 'Max', tagline: 'No limits, for daily prep', cta: 'Get Max', benefits: ['hld', 'referrals', 'optimizer'] },
}
const toneOf = (id) => (PLAN_TONE[id] || PLAN_TONE.free).tone

const FAQ_BASE = [
    ['Is there a free plan?', 'Yes. Free gives you some of every feature, forever.'],
    ['Can I change plans later?', 'Yes. A new term starts on the day you switch.'],
    ['What happens when my term ends?', 'Nothing renews. You go back to Free.'],
]
const PAYMENT_FAQ = {
    INR: ['Which payment methods work?', 'Indian cards, UPI and net banking, through Razorpay.'],
    USD: ['Which payment methods work?', 'PayPal and international cards, through Razorpay.'],
}

const isInf = (v) => v === Infinity || v === 'unlimited'
const rupees = (paise) => `₹${Math.round((paise || 0) / 100).toLocaleString('en-IN')}`
const dollars = (cents) => `$${(Math.round((cents || 0)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
// Geo-based currency (lib/geo.js on the server): India (and unknown, the
// safe default) sees/pays INR; everyone else sees/pays USD.
const priceOf = (plan, period, currency) => (currency === 'USD' ? priceUsdCents(plan, period) : priceInrPaise(plan, period))
const money = (amount, currency) => (currency === 'USD' ? dollars(amount) : rupees(amount))

// ── Feature list (benefits on the cards + the compare sheet) ─────────
// `label(v)` renders the "on" copy for that tier's limit, `offLabel` is the
// plain noun shown crossed out when the tier doesn't have the feature (limit 0).
const FEATURE_ROWS = [
    { key: 'dsa', limitKey: 'dsa_catalog_visible', label: (v) => (isInf(v) ? 'All DSA problems' : `${v} DSA problems`) },
    { key: 'lld', limitKey: 'lld_catalog_visible', label: (v) => (isInf(v) ? `All ${TERMS.lld.one.toLowerCase()} problems` : `${v} ${TERMS.lld.one.toLowerCase()} problems`) },
    {
        key: 'hld',
        limitKey: 'hld_practice_per_month',
        label: (v) => (isInf(v) ? `Unlimited ${TERMS.hld.one.toLowerCase()} practice` : `${v} ${TERMS.hld.one.toLowerCase()} practice${v === 1 ? '' : 's'} / mo`),
        offLabel: `${TERMS.hld.one} practice`,
    },
    { key: 'jobs', limitKey: 'jobs_visible', label: (v) => (isInf(v) ? 'All job listings' : `${v} job listings`) },
    {
        key: 'jobAlerts',
        limitKey: 'company_subscriptions_max',
        label: (v) => (isInf(v) ? 'Unlimited job alerts' : `${v} company job alert${v === 1 ? '' : 's'}`),
        offLabel: 'Company job alerts',
    },
    {
        key: 'referrals',
        limitKey: 'referral_requests_per_month',
        label: (v) => (isInf(v) ? 'Unlimited referral requests' : `${v} referral requests / mo`),
        offLabel: 'Referral requests',
    },
    { key: 'interview', limitKey: 'interview_q_per_subcategory', label: (v) => (isInf(v) ? 'All interview questions' : `${v} interview questions / topic`) },
    {
        key: 'optimizer',
        limitKey: 'resume_optimizer_per_month',
        label: (v) => (isInf(v) ? 'Unlimited resume checks' : `${v} resume checks / mo`),
        offLabel: 'Resume check',
    },
]

function planFeatureRows(planId) {
    const l = (TIERS[planId] || TIERS.free).limits
    return FEATURE_ROWS.map((row) => {
        const v = l[row.limitKey]
        const included = isInf(v) || v > 0
        return { key: row.key, included, label: included ? row.label(v) : (row.offLabel || row.label(0)) }
    })
}

function FeatureChecklist({ rows }) {
    return (
        <ul className="pricing-features">
            {rows.map((r) => (
                <li key={r.key} className={r.included ? 'is-on' : 'is-off'}>
                    {r.included ? <Check size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
                    <span>{r.label}</span>
                    {!r.included && <span className="sys-sr">(not included)</span>}
                </li>
            ))}
        </ul>
    )
}

// One plan card: name · price · 3 benefits · one CTA.
function PlanCard({ id, billing, currency, isCurrent, pending, onCheckout }) {
    const meta = PLAN_META[id] || { name: id }
    const amount = priceOf(id, billing, currency)
    const yearlyAmount = priceOf(id, 'yearly', currency)
    const headline = billing === 'yearly' ? money(yearlyAmount / 12, currency) : money(amount, currency)
    const benefitKeys = meta.benefits || []
    const rows = planFeatureRows(id).filter((r) => benefitKeys.includes(r.key))
    const featured = !!meta.badge

    return (
        <article className={`pricing-card tone-${toneOf(id)}${featured ? ' is-featured' : ''}`} aria-label={`${meta.name} plan`}>
            <div className="pricing-card-head">
                <span className="pricing-name tone-text">{meta.name}</span>
                {isCurrent ? <Pill tone={toneOf(id)}>Current</Pill> : featured && <Pill tone={toneOf(id)} soft>{meta.badge}</Pill>}
            </div>
            <div className="pricing-price">
                <span className="pricing-amount">{headline}</span>
                <span className="pricing-per">/mo</span>
            </div>
            <p className="pricing-billed">
                {billing === 'yearly' ? `${money(yearlyAmount, currency)} once a year` : meta.tagline}
            </p>

            <FeatureChecklist rows={rows} />

            <Button
                variant={isCurrent ? 'secondary' : featured ? 'upgrade' : 'primary'}
                size="lg"
                block
                className="pricing-cta"
                onClick={() => {
                    if (isCurrent || pending) return
                    trackUi(TRACK.CTA_CLICK, { id: `pricing_${id}`, section: 'me' })
                    onCheckout(id)
                }}
                disabled={isCurrent || pending === id}
                busy={pending === id}
                busyLabel="Starting…"
            >
                {isCurrent ? 'Current plan' : meta.cta}
            </Button>
        </article>
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
        <ul className="sys-rows pricing-aa" aria-label="Add-ons">
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

export default function PricingPage() {
    const { plan: currentPlan, currency, refetch } = useEntitlements()
    const { user } = useAuth()
    const navigate = useNavigate()
    const [billing, setBilling] = useState('monthly') // 'monthly' | 'yearly'
    const [note, setNote] = useState('')
    const [pending, setPending] = useState('') // plan id whose modal is open / verifying
    const [sheet, setSheet] = useState(null) // null | 'compare' | 'coupon'

    useEffect(() => {
        track(EVENTS.PRICING_VIEWED)
    }, [])

    const savingsPct = (plan) => {
        const m = priceOf(plan, 'monthly', currency)
        const y = priceOf(plan, 'yearly', currency)
        return m && y ? Math.round((1 - y / (m * 12)) * 100) : 0
    }
    const bestSavings = Math.max(...PAID_PLANS.map(savingsPct))

    async function startCheckout(plan) {
        if (!user) { setNote('Please sign in first.'); return }
        setNote('')
        setPending(plan)
        track(EVENTS.CHECKOUT_STARTED, { plan, billing })
        try {
            await startRazorpayCheckoutFlow({ plan, billingPeriod: billing, user })
            track(EVENTS.CHECKOUT_COMPLETED, { plan, billing })
            refetch()
            navigate('/subscription/success')
        } catch (err) {
            if (err?.code === 'dismissed') {
                // user closed the modal — no error message needed
            } else if (err?.code === 'unconfigured') {
                setNote('Payments aren’t connected yet.')
            } else {
                setNote(err?.message || 'Could not complete the payment.')
            }
        } finally {
            setPending('')
        }
    }

    const [couponCode, setCouponCode] = useState('')
    const [couponBusy, setCouponBusy] = useState(false)
    const [couponMsg, setCouponMsg] = useState(null) // { ok, text }

    async function redeemPlanCoupon() {
        if (!user) { setCouponMsg({ ok: false, text: 'Please sign in first.' }); return }
        const code = couponCode.trim().toUpperCase()
        if (!code) return
        setCouponBusy(true)
        setCouponMsg(null)
        try {
            const r = await apiFetch('/api/payments/coupon', { json: { code, billingPeriod: billing } })
            refetch()
            setCouponMsg({ ok: true, text: `${r.plan === 'max' ? 'Max' : 'Pro'} plan is active until ${new Date(r.current_period_end).toLocaleDateString()}.` })
        } catch (err) {
            setCouponMsg({ ok: false, text: err?.body?.message || err?.message || 'Could not apply the coupon.' })
        } finally {
            setCouponBusy(false)
        }
    }

    const closeSheet = () => setSheet(null)

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
            <PageContainer width="sm" className="pricing-wrap">
                <PageHeader section="me" title="Plans" subtitle="Nothing auto-renews. Cancel anytime." />

                <div className="pricing-controls">
                    <Segmented label="Billing period" value={billing} onChange={setBilling}
                        options={[{ value: 'monthly', label: 'Monthly' }, { value: 'yearly', label: 'Yearly', tone: 'success' }]} />
                    {bestSavings > 0 && <Pill tone="success" soft>Save {bestSavings}%</Pill>}
                </div>

                <div className="pricing-grid">
                    {PAID_PLANS.map((id) => (
                        <PlanCard
                            key={id}
                            id={id}
                            billing={billing}
                            currency={currency}
                            isCurrent={currentPlan === id}
                            pending={pending}
                            onCheckout={startCheckout}
                        />
                    ))}
                </div>

                {note && <ErrorState compact title="Checkout" message={note} />}

                <div className="pricing-links">
                    <button type="button" className="link-btn" onClick={() => setSheet('compare')}>Compare all features</button>
                    <button type="button" className="link-btn" onClick={() => setSheet('coupon')}>Have a code?</button>
                </div>

                {AUTOAPPLY_ENABLED && <AutoApplyRow currentPlan={currentPlan} />}

                <section className="pricing-faq prose" aria-labelledby="pricing-faq-h">
                    <h2 id="pricing-faq-h" className="pricing-h2">Questions</h2>
                    {[...FAQ_BASE, PAYMENT_FAQ[currency] || PAYMENT_FAQ.INR].map(([q, a]) => (
                        <details key={q}>
                            <summary>{q}</summary>
                            <p>{a}</p>
                        </details>
                    ))}
                </section>

                <p className="pricing-fine">
                    Prices in {currency === 'USD' ? 'USD' : 'INR'}. Secure checkout by Razorpay. One payment per term.
                </p>
            </PageContainer>

            <Sheet open={sheet === 'compare'} onClose={closeSheet} title="Compare all features" size="full">
                <div className="pricing-compare">
                    {PLAN_ORDER.map((id) => (
                        <section key={id} className={`pricing-compare-plan tone-${toneOf(id)}`} aria-label={`${(PLAN_META[id] || { name: id }).name} plan features`}>
                            <h3 className="pricing-name tone-text">
                                {(PLAN_META[id] || { name: id }).name}
                                <span className="pricing-compare-price">
                                    {id === 'free' ? (currency === 'USD' ? '$0' : '₹0') : `${money(priceOf(id, 'monthly', currency), currency)}/mo`}
                                </span>
                            </h3>
                            <FeatureChecklist rows={planFeatureRows(id)} />
                        </section>
                    ))}
                </div>
            </Sheet>

            <Sheet open={sheet === 'coupon'} onClose={closeSheet} title="Have a code?" description="Enter your coupon to unlock a plan.">
                <form onSubmit={(e) => { e.preventDefault(); redeemPlanCoupon() }} className="pricing-coupon">
                    <label htmlFor="plan-coupon" className="sys-field-label">Coupon code</label>
                    <input id="plan-coupon" className="input-field" placeholder="e.g. WELCOME" maxLength={40} value={couponCode}
                        autoComplete="off" autoCapitalize="characters"
                        onChange={(e) => { setCouponCode(e.target.value); setCouponMsg(null) }}
                        disabled={couponBusy} />
                    <Button type="submit" variant="primary" size="lg" block disabled={!couponCode.trim()} busy={couponBusy} busyLabel="Applying…">Apply code</Button>
                    {couponMsg && (
                        <p role="status" className={`pricing-coupon-msg tone-text tone-${couponMsg.ok ? 'success' : 'danger'}`}>
                            {couponMsg.text}
                        </p>
                    )}
                </form>
            </Sheet>
        </>
    )
}

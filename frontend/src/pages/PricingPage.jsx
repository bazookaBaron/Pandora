import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { TIERS, PLAN_ORDER, priceInrPaise, priceUsdCents } from '../../config/tiers.js'
import { useEntitlements } from '../lib/useEntitlements'
import { useAuth } from '../contexts/AuthContext'
import { useMediaQuery } from '../lib/useMediaQuery'
import { ErrorState } from '../components/shared/states'
import { track, EVENTS } from '../lib/analytics'
import { startCheckout as startRazorpayCheckoutFlow } from '../lib/razorpay'
import { apiFetch } from '../lib/apiClient'
import { useAutoApplyMe } from '../lib/useAutoApply'
import { PACK_KINDS, PACK_SIZES, packPrice } from './autoapply/ui'
import { Check, X } from 'lucide-react'
import { PLAN_TONE } from '../lib/brand'
import { Segmented, Pill, Button } from '../components/ui'

// ── Pricing (config-driven) ─────────────────────────────────────────
// Renders Free / Pro / Max straight from `config/tiers.js`. The Pro/Max CTAs
// open Razorpay Standard Checkout (one-time payment for a monthly / yearly
// term). On a verified payment we re-poll entitlements.
//
// Desktop: the usual 3-card grid. Mobile: a Free/Pro/Max segmented switcher
// (defaults to Pro) shows ONE full plan card at a time — same <PlanCard> either way.
// Plan colours come from lib/brand.js PLAN_TONE (free history, pro plan, max active).

const PLAN_META = {
    free: { name: 'Free', tagline: 'Kick the tyres', cta: 'Start free' },
    pro: { name: 'Pro', tagline: 'Everything, no limits', featured: true, badge: 'Most popular', cta: 'Get Pro' },
    max: { name: 'Max', tagline: 'For serious, daily prep', cta: 'Get Max' },
}
const toneOf = (id) => (PLAN_TONE[id] || PLAN_TONE.free).tone

const TRUST = ['Cancel anytime', 'No auto-renewal', 'Secure checkout by Razorpay']

const FAQ_BASE = [
    ['Is there a free plan?', 'Yes — Free gives you a limited amount of every feature, forever. Upgrade only when you hit the limits.'],
    ['Can I change plans later?', 'Yes — upgrade or downgrade whenever you like. A new term starts from the day you switch.'],
    ['What happens when my term ends?', 'Nothing auto-renews. You drop back to Free and can subscribe again whenever you want.'],
]
const PAYMENT_FAQ = {
    INR: ['Which payment methods work?', 'All major Indian cards, UPI and net-banking, handled securely by Razorpay.'],
    USD: ['Which payment methods work?', 'PayPal and major international cards, handled securely by Razorpay.'],
}

const isInf = (v) => v === Infinity || v === 'unlimited'
const rupees = (paise) => `₹${Math.round((paise || 0) / 100).toLocaleString('en-IN')}`
const dollars = (cents) => `$${(Math.round((cents || 0)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
// Geo-based currency (lib/geo.js on the server): India (and unknown, the
// safe default) sees/pays INR; everyone else sees/pays USD. One switch here
// instead of scattering `currency === 'USD' ? ... : ...` through the page.
const priceOf = (plan, period, currency) => (currency === 'USD' ? priceUsdCents(plan, period) : priceInrPaise(plan, period))
const money = (amount, currency) => (currency === 'USD' ? dollars(amount) : rupees(amount))

// ── Feature checklist (shared by desktop cards + the mobile tab view) ─
// One row per feature; `label(v)` renders the "on" copy for that tier's
// limit, `offLabel` is the plain noun shown crossed out when the tier
// doesn't have the feature at all (limit === 0).
const FEATURE_ROWS = [
    {
        key: 'dsa',
        limitKey: 'dsa_catalog_visible',
        label: (v) => (isInf(v) ? 'All DSA problems' : `${v} DSA problems`),
    },
    {
        key: 'lld',
        limitKey: 'lld_catalog_visible',
        label: (v) => (isInf(v) ? 'All LLD problems' : `${v} LLD problems`),
    },
    {
        key: 'hld',
        limitKey: 'hld_practice_per_month',
        label: (v) => (isInf(v) ? 'Unlimited HLD practice' : `${v} HLD practice${v === 1 ? '' : 's'} / mo`),
        offLabel: 'HLD practice',
    },
    {
        key: 'jobs',
        limitKey: 'jobs_visible',
        label: (v) => (isInf(v) ? 'All job listings' : `${v} job listings`),
    },
    {
        key: 'jobAlerts',
        limitKey: 'company_subscriptions_max',
        label: (v) => (isInf(v) ? 'Unlimited company job alerts' : `${v} company job alert${v === 1 ? '' : 's'}`),
        offLabel: 'Company job alerts',
    },
    {
        key: 'referrals',
        limitKey: 'referral_requests_per_month',
        label: (v) => (isInf(v) ? 'Unlimited referral requests' : `${v} referral requests / mo`),
        offLabel: 'Referral requests',
    },
    {
        key: 'interview',
        limitKey: 'interview_q_per_subcategory',
        label: (v) => (isInf(v) ? 'All interview questions' : `${v} interview questions / topic`),
    },
    {
        key: 'optimizer',
        limitKey: 'resume_optimizer_per_month',
        label: (v) => (isInf(v) ? 'Unlimited resume optimizer' : `${v} job-specific resume optimizations / mo`),
        offLabel: 'Job-specific resume optimizer',
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
                    {r.included ? <Check size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
                    <span>{r.label}</span>
                    {!r.included && <span className="sys-sr">(not included)</span>}
                </li>
            ))}
        </ul>
    )
}

// One full plan card — price block + checklist + CTA. Used for every card on
// desktop and for the single selected plan on mobile.
function PlanCard({ id, billing, currency, isCurrent, pending, onCheckout }) {
    const meta = PLAN_META[id] || { name: id }
    const amount = priceOf(id, billing, currency)
    const featured = !!meta.featured
    const yearlyAmount = priceOf(id, 'yearly', currency)
    const zero = currency === 'USD' ? '$0' : '₹0'
    const headline = id === 'free' ? zero : billing === 'yearly' ? money(yearlyAmount / 12, currency) : money(amount, currency)
    const rows = planFeatureRows(id)
    const savingsPct = (() => {
        const m = priceOf(id, 'monthly', currency)
        return m && yearlyAmount ? Math.round((1 - yearlyAmount / (m * 12)) * 100) : 0
    })()
    const variant = isCurrent || id === 'free' ? 'secondary' : featured ? 'upgrade' : 'primary'

    return (
        <article className={`pricing-card tone-${toneOf(id)}${featured ? ' is-featured' : ''}`} aria-label={`${meta.name} plan`}>
            {featured && meta.badge && !isCurrent && <span className="pricing-badge">{meta.badge}</span>}

            <div className="pricing-card-head">
                <span className="pricing-name tone-text">{meta.name}</span>
                {isCurrent && <Pill tone={toneOf(id)}>Current</Pill>}
            </div>
            <p className="pricing-tagline">{meta.tagline}</p>
            <div className="pricing-price">
                <span className="pricing-amount">{headline}</span>
                <span className="pricing-per">{id === 'free' ? 'forever' : '/mo'}</span>
            </div>
            {id !== 'free' && (
                <p className="pricing-billed">
                    {billing === 'yearly'
                        ? `${money(yearlyAmount, currency)} billed once a year`
                        : `or ${money(yearlyAmount, currency)}/yr — save ${savingsPct}%`}
                </p>
            )}

            <FeatureChecklist rows={rows} />

            <Button
                variant={variant}
                size="lg"
                block
                className="pricing-cta"
                onClick={() => {
                    if (isCurrent || id === 'free' || pending) return
                    onCheckout(id)
                }}
                disabled={isCurrent || id === 'free' || pending === id}
                busy={pending === id}
                busyLabel="Starting…"
            >
                {isCurrent ? 'Current plan' : meta.cta}
            </Button>
        </article>
    )
}

// ── AutoApply packs (prices come from GET /api/autoapply/me -> config.packs) ─
function AutoApplySection({ currentPlan }) {
    const me = useAutoApplyMe()
    const config = me.data?.config
    const cap = config?.monthly_cap ?? 1000
    const eligible = me.data ? !!me.data.eligible : currentPlan === 'pro' || currentPlan === 'max'
    return (
        <section aria-labelledby="pricing-autoapply" className="pricing-block">
            <div className="pricing-block-head">
                <Pill tone="attention" soft>Add-on · Pro &amp; Max</Pill>
                <h2 id="pricing-autoapply" className="pricing-h2">AutoApply packs</h2>
                <p className="pricing-sub">
                    We apply on company career sites for you. Credits are used only when an application is submitted
                    &mdash; up to {cap.toLocaleString('en-IN')} a month.
                </p>
            </div>
            <div className="pricing-packs">
                {['service', 'product'].map((kind) => (
                    <div key={kind} className={`pricing-pack tone-${kind === 'service' ? 'active' : 'attention'}`}>
                        <div className="pricing-name tone-text">{PACK_KINDS[kind].name}</div>
                        <div className="pricing-tagline">{PACK_KINDS[kind].blurb}</div>
                        <ul>
                            {PACK_SIZES.map((size) => {
                                const p = packPrice(config, kind, size)
                                return (
                                    <li key={size}>
                                        <span>{size} applications</span>
                                        <strong>{p != null ? rupees(p) : (me.isLoading ? '…' : 'Coming soon')}</strong>
                                    </li>
                                )
                            })}
                        </ul>
                    </div>
                ))}
            </div>
            <p className="pricing-center">
                <Button variant={eligible ? 'primary' : 'secondary'} to={eligible ? '/autoapply/buy' : '/autoapply'}>
                    {eligible ? 'Buy an AutoApply pack' : 'Learn about AutoApply'}
                </Button>
            </p>
            {!eligible && <p className="pricing-fine">Needs an active Pro or Max plan.</p>}
        </section>
    )
}

export default function PricingPage() {
    const { plan: currentPlan, currency, refetch } = useEntitlements()
    const { user } = useAuth()
    const navigate = useNavigate()
    const isMobile = useMediaQuery('(max-width: 767px)')
    const [billing, setBilling] = useState('monthly') // 'monthly' | 'yearly'
    const [mobilePlan, setMobilePlan] = useState('pro') // mobile tab selection — defaults to Pro
    const [note, setNote] = useState('')
    const [pending, setPending] = useState('') // plan id whose modal is open / verifying

    useEffect(() => {
        track(EVENTS.PRICING_VIEWED)
    }, [])

    const savingsPct = (plan) => {
        const m = priceOf(plan, 'monthly', currency)
        const y = priceOf(plan, 'yearly', currency)
        return m && y ? Math.round((1 - y / (m * 12)) * 100) : 0
    }
    const bestSavings = Math.max(savingsPct('pro'), savingsPct('max'))

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

    const visiblePlans = isMobile ? [mobilePlan] : PLAN_ORDER

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
            <main className="wrap pricing-wrap">
                <header className="pricing-header">
                    <h1 className="pricing-h1">Prep like it&rsquo;s your job.</h1>
                    <p className="pricing-sub">
                        One plan for DSA, LLD, HLD, jobs, referrals, interview questions and the resume optimizer.
                        Nothing auto-renews.
                    </p>

                    <div className="pricing-controls">
                        <Segmented label="Billing period" value={billing} onChange={setBilling}
                            options={[{ value: 'monthly', label: 'Monthly' }, { value: 'yearly', label: 'Yearly', tone: 'success' }]} />
                        {bestSavings > 0 && <Pill tone="success" soft>Save up to {bestSavings}%</Pill>}
                    </div>

                    {/* Mobile: Free / Pro / Max switcher — replaces the 3 stacked cards. */}
                    {isMobile && (
                        <Segmented label="Choose a plan" block value={mobilePlan} onChange={setMobilePlan} className="pricing-plan-switch"
                            options={PLAN_ORDER.map((id) => ({ value: id, label: (PLAN_META[id] || { name: id }).name, tone: toneOf(id) }))} />
                    )}
                </header>

                <div className="pricing-grid">
                    {visiblePlans.map((id) => (
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

                <ul className="pricing-trust">
                    {TRUST.map((t) => (
                        <li key={t}><Check size={13} aria-hidden="true" />{t}</li>
                    ))}
                </ul>

                {note && (
                    <ErrorState compact title="Checkout" message={note} style={{ marginTop: 18 }} />
                )}

                <form onSubmit={(e) => { e.preventDefault(); redeemPlanCoupon() }} className="pricing-coupon">
                    <label htmlFor="plan-coupon" className="sys-sr">Coupon code</label>
                    <input id="plan-coupon" className="input-field" placeholder="Coupon code" maxLength={40} value={couponCode}
                        onChange={(e) => { setCouponCode(e.target.value); setCouponMsg(null) }}
                        disabled={couponBusy} />
                    <Button type="submit" disabled={!couponCode.trim()} busy={couponBusy} busyLabel="Applying…">Apply</Button>
                    {couponMsg && (
                        <span role="status" className={`pricing-coupon-msg tone-text tone-${couponMsg.ok ? 'success' : 'danger'}`}>
                            {couponMsg.text}
                        </span>
                    )}
                </form>

                {import.meta.env.VITE_AUTOAPPLY === '1' && <AutoApplySection currentPlan={currentPlan} />}

                <section className="pricing-block pricing-faq prose" aria-labelledby="pricing-faq-h">
                    <h2 id="pricing-faq-h" className="pricing-h2">Questions</h2>
                    {[...FAQ_BASE, PAYMENT_FAQ[currency] || PAYMENT_FAQ.INR].map(([q, a]) => (
                        <details key={q}>
                            <summary>{q}</summary>
                            <p>{a}</p>
                        </details>
                    ))}
                </section>

                <p className="pricing-fine">
                    Prices in {currency === 'USD' ? 'USD' : 'INR'}, processed securely by Razorpay. Every plan is a one-time payment
                    for the selected term — nothing auto-renews.
                </p>
            </main>
        </>
    )
}

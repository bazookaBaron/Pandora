import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { TIERS, PLAN_ORDER, priceInrPaise } from '../../config/tiers.js'
import { useEntitlements } from '../lib/useEntitlements'
import { useAuth } from '../contexts/AuthContext'
import { useMediaQuery } from '../lib/useMediaQuery'
import { ErrorState } from '../components/shared/states'
import { track, EVENTS } from '../lib/analytics'
import { startCheckout as startRazorpayCheckoutFlow } from '../lib/razorpay'

// ── Pricing (config-driven) ─────────────────────────────────────────
// Renders Free / Pro / Max straight from `config/tiers.js`. The Pro/Max CTAs
// open Razorpay Standard Checkout (one-time payment for a monthly / yearly
// term). On a verified payment we re-poll entitlements.
//
// Desktop: the usual 3-card grid. Mobile: a Free/Pro/Max tab switcher
// (defaults to Pro) shows ONE full plan card at a time instead of three
// stacked blocks — same <PlanCard> either way.

const PLAN_META = {
    free: { name: 'Free', tagline: 'Kick the tyres', accent: '#71717a', cta: 'Start free' },
    pro: { name: 'Pro', tagline: 'Everything, no limits', accent: '#a78bfa', featured: true, badge: 'Most popular', cta: 'Get Pro' },
    max: { name: 'Max', tagline: 'For serious, daily prep', accent: '#22d3ee', cta: 'Get Max' },
}

const TRUST = ['Cancel anytime', 'No auto-renewal', 'Secure checkout by Razorpay']

const FAQ = [
    ['Is there a free plan?', 'Yes — Free gives you a limited amount of every feature, forever. Upgrade only when you hit the limits.'],
    ['Can I change plans later?', 'Yes — upgrade or downgrade whenever you like. A new term starts from the day you switch.'],
    ['What happens when my term ends?', 'Nothing auto-renews. You drop back to Free and can subscribe again whenever you want.'],
    ['Which payment methods work?', 'All major Indian cards, UPI and net-banking, handled securely by Razorpay.'],
]

const isInf = (v) => v === Infinity || v === 'unlimited'
const rupees = (paise) => `₹${Math.round((paise || 0) / 100).toLocaleString('en-IN')}`

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
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 9 }}>
            {rows.map((r) => (
                <li key={r.key} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 9,
                    fontSize: '0.82rem', lineHeight: 1.4,
                    color: r.included ? 'var(--accent)' : 'var(--faint)',
                }}>
                    <span aria-hidden style={{
                        flexShrink: 0, width: 16, textAlign: 'center', fontWeight: 900,
                        color: r.included ? 'var(--green)' : '#71717a',
                    }}>
                        {r.included ? '✓' : '✕'}
                    </span>
                    <span style={{ textDecoration: r.included ? 'none' : 'line-through', textDecorationColor: '#71717a' }}>
                        {r.label}
                    </span>
                </li>
            ))}
        </ul>
    )
}

// One full plan card — price block + checklist + CTA. Used for every card on
// desktop and for the single selected plan on mobile.
function PlanCard({ id, billing, isCurrent, pending, onCheckout }) {
    const meta = PLAN_META[id] || { name: id, accent: '#71717a' }
    const paise = priceInrPaise(id, billing)
    const featured = !!meta.featured
    const yearlyPaise = priceInrPaise(id, 'yearly')
    const headline = id === 'free' ? '₹0' : billing === 'yearly' ? rupees(yearlyPaise / 12) : rupees(paise)
    const rows = planFeatureRows(id)
    const savingsPct = (() => {
        const m = priceInrPaise(id, 'monthly')
        return m && yearlyPaise ? Math.round((1 - yearlyPaise / (m * 12)) * 100) : 0
    })()

    return (
        <div style={{
            position: 'relative',
            background: 'var(--panel)',
            border: `1px solid ${featured ? meta.accent + '66' : 'var(--subtle)'}`,
            borderRadius: 14, padding: '24px 20px 20px',
            display: 'flex', flexDirection: 'column', gap: 14,
            boxShadow: featured ? `0 20px 44px -16px ${meta.accent}55` : 'none',
        }}>
            {featured && meta.badge && !isCurrent && (
                <span style={{
                    position: 'absolute', top: -11, left: '50%', transform: 'translateX(-50%)',
                    fontSize: '0.58rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.12em',
                    color: 'var(--surface)', background: 'linear-gradient(135deg, #22d3ee, #a78bfa)',
                    borderRadius: 999, padding: '4px 12px', whiteSpace: 'nowrap',
                }}>
                    {meta.badge}
                </span>
            )}
            {isCurrent && (
                <span style={{
                    position: 'absolute', top: 14, right: 14, fontSize: '0.58rem', fontWeight: 900,
                    textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--surface)',
                    background: meta.accent, borderRadius: 6, padding: '3px 8px',
                }}>
                    Current
                </span>
            )}

            <div>
                <div style={{ fontSize: '0.7rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: meta.accent }}>{meta.name}</div>
                <div style={{ color: 'var(--muted)', fontSize: '0.76rem', marginTop: 3 }}>{meta.tagline}</div>
                <div style={{ marginTop: 12, display: 'flex', alignItems: 'baseline', gap: 5, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '2rem', fontWeight: 900, color: 'var(--bright)', letterSpacing: '-0.02em' }}>{headline}</span>
                    <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{id === 'free' ? 'forever' : '/mo'}</span>
                </div>
                {id !== 'free' && (
                    <div style={{ fontSize: '0.68rem', color: 'var(--faint)', marginTop: 4 }}>
                        {billing === 'yearly'
                            ? `${rupees(yearlyPaise)} billed once a year`
                            : `or ${rupees(yearlyPaise)}/yr — save ${savingsPct}%`}
                    </div>
                )}
            </div>

            <FeatureChecklist rows={rows} />

            <button
                onClick={() => {
                    if (isCurrent || id === 'free' || pending) return
                    onCheckout(id)
                }}
                disabled={isCurrent || id === 'free' || pending === id}
                style={{
                    marginTop: 'auto', padding: '11px 16px', borderRadius: 8,
                    border: id === 'free' && !isCurrent ? '1px solid var(--subtle)' : 'none',
                    cursor: (isCurrent || id === 'free' || pending === id) ? 'default' : 'pointer',
                    fontWeight: 900, fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.06em',
                    opacity: pending === id ? 0.7 : 1,
                    background: isCurrent ? 'var(--subtle)'
                        : id === 'free' ? 'transparent'
                            : featured ? 'linear-gradient(135deg, #22d3ee, #a78bfa)'
                                : meta.accent,
                    color: isCurrent ? 'var(--muted)'
                        : id === 'free' ? 'var(--accent)'
                            : 'var(--surface)',
                }}
            >
                {pending === id ? 'Starting…' : isCurrent ? 'Current plan' : meta.cta}
            </button>
        </div>
    )
}

export default function PricingPage() {
    const { plan: currentPlan, refetch } = useEntitlements()
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
        const m = priceInrPaise(plan, 'monthly')
        const y = priceInrPaise(plan, 'yearly')
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

    const visiblePlans = isMobile ? [mobilePlan] : PLAN_ORDER

    return (
        <>
            <Navbar />
            {pending && (
                <div
                    aria-live="polite"
                    style={{
                        position: 'fixed', inset: 0, zIndex: 200, display: 'grid', placeItems: 'center',
                        background: 'var(--overlay)', backdropFilter: 'blur(2px)',
                    }}
                >
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, color: 'var(--bright)' }}>
                        <span className="spinner-lg" />
                        <span style={{ fontSize: '0.82rem', fontWeight: 700 }}>Opening secure checkout…</span>
                    </div>
                </div>
            )}
            <main className="wrap" style={{ maxWidth: 1040, margin: '0 auto', padding: '72px 16px 40px' }}>
                <header style={{ textAlign: 'center', marginBottom: 26 }}>
                    <span style={{
                        display: 'inline-block', fontSize: '0.6rem', fontWeight: 900, letterSpacing: '0.16em',
                        textTransform: 'uppercase', color: 'var(--pop)', border: '1px solid var(--subtle)',
                        borderRadius: 999, padding: '4px 12px', marginBottom: 14,
                    }}>
                        Pricing
                    </span>
                    <h1 style={{ fontSize: '1.9rem', fontWeight: 900, color: 'var(--bright)', letterSpacing: '-0.03em', lineHeight: 1.15 }}>
                        Prep like it&rsquo;s your job.
                    </h1>
                    <p style={{ color: 'var(--muted)', fontSize: '0.9rem', maxWidth: 520, margin: '10px auto 0', lineHeight: 1.55 }}>
                        One subscription covers DSA, LLD, HLD, the jobs board, referrals, interview questions and the AI resume optimizer.
                        Nothing auto-renews &mdash; you&rsquo;re always in control.
                    </p>

                    {/* Monthly / yearly toggle + savings pill */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
                        <div className="profile-segment" role="group" aria-label="Billing period">
                            {['monthly', 'yearly'].map((b) => (
                                <button
                                    key={b}
                                    type="button"
                                    className={'profile-segment-btn' + (billing === b ? ' is-active' : '')}
                                    aria-pressed={billing === b}
                                    onClick={() => setBilling(b)}
                                >
                                    {b === 'monthly' ? 'Monthly' : 'Yearly'}
                                </button>
                            ))}
                        </div>
                        {bestSavings > 0 && (
                            <span style={{
                                fontSize: '0.68rem', fontWeight: 900, color: 'var(--green)',
                                background: 'rgba(74,222,128,0.14)', border: '1px solid rgba(74,222,128,0.4)',
                                borderRadius: 999, padding: '4px 10px',
                            }}>
                                Save up to {bestSavings}% yearly
                            </span>
                        )}
                    </div>

                    {/* Mobile: Free / Pro / Max tab switcher — replaces the 3 stacked cards. */}
                    {isMobile && (
                        <div role="tablist" aria-label="Choose a plan" style={{
                            display: 'flex', gap: 6, marginTop: 16, maxWidth: 420, marginLeft: 'auto', marginRight: 'auto',
                        }}>
                            {PLAN_ORDER.map((id) => {
                                const meta = PLAN_META[id] || { name: id, accent: '#71717a' }
                                const active = mobilePlan === id
                                return (
                                    <button
                                        key={id}
                                        type="button"
                                        role="tab"
                                        aria-selected={active}
                                        onClick={() => setMobilePlan(id)}
                                        style={{
                                            flex: 1, padding: '9px 4px', borderRadius: 8, cursor: 'pointer',
                                            border: `1px solid ${active ? meta.accent + '88' : 'var(--subtle)'}`,
                                            background: active ? meta.accent + '1a' : 'var(--panel)',
                                            color: active ? meta.accent : 'var(--muted)',
                                            fontWeight: 900, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em',
                                        }}
                                    >
                                        {meta.name.toUpperCase()}
                                    </button>
                                )
                            })}
                        </div>
                    )}
                </header>

                <div style={{
                    display: 'grid',
                    gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(258px, 1fr))',
                    gap: 18, alignItems: 'start',
                    maxWidth: isMobile ? 420 : undefined, marginLeft: isMobile ? 'auto' : undefined, marginRight: isMobile ? 'auto' : undefined,
                }}>
                    {visiblePlans.map((id) => (
                        <PlanCard
                            key={id}
                            id={id}
                            billing={billing}
                            isCurrent={currentPlan === id}
                            pending={pending}
                            onCheckout={startCheckout}
                        />
                    ))}
                </div>

                <div style={{ display: 'flex', justifyContent: 'center', gap: 18, flexWrap: 'wrap', marginTop: 20 }}>
                    {TRUST.map((t) => (
                        <span key={t} style={{ fontSize: '0.72rem', color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ color: 'var(--green)' }}>✓</span>{t}
                        </span>
                    ))}
                </div>

                {note && (
                    <ErrorState compact title="Checkout" message={note} style={{ marginTop: 18 }} />
                )}

                <section style={{ maxWidth: 680, margin: '44px auto 0' }}>
                    <h2 style={{ fontSize: '1rem', fontWeight: 900, color: 'var(--bright)', textAlign: 'center', marginBottom: 16, letterSpacing: '-0.02em' }}>
                        Questions
                    </h2>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {FAQ.map(([q, a]) => (
                            <div key={q} style={{ background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '14px 16px' }}>
                                <div style={{ fontSize: '0.82rem', fontWeight: 800, color: 'var(--bright)' }}>{q}</div>
                                <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: 6, lineHeight: 1.55 }}>{a}</div>
                            </div>
                        ))}
                    </div>
                </section>

                <p style={{ textAlign: 'center', marginTop: 28, fontSize: '0.72rem', color: 'var(--faint)' }}>
                    Prices in INR, processed securely by Razorpay. Every plan is a one-time payment for the
                    selected term — nothing auto-renews, so there is never a surprise charge.
                </p>
                <p style={{ textAlign: 'center', marginTop: 12 }}>
                    <Link to="/" style={{ color: 'var(--pop)', fontSize: '0.8rem', textDecoration: 'none' }}>← Back</Link>
                </p>
            </main>
        </>
    )
}

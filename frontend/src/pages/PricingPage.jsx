import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { TIERS, PLAN_ORDER, priceInrPaise } from '../../config/tiers.js'
import { useEntitlements } from '../lib/useEntitlements'
import { useAuth } from '../contexts/AuthContext'
import { ErrorState } from '../components/shared/states'
import { track, EVENTS } from '../lib/analytics'
import { startCheckout as startRazorpayCheckoutFlow } from '../lib/razorpay'

// ── Pricing (config-driven) ─────────────────────────────────────────
// Renders Free / Pro / Max straight from `config/tiers.js`. The Pro/Max CTAs
// open Razorpay Standard Checkout (one-time payment for a monthly / yearly
// term). On a verified payment we re-poll entitlements.

const PLAN_META = {
    free: { name: 'Free', tagline: 'Kick the tyres', accent: '#71717a', cta: 'Start free' },
    pro: { name: 'Pro', tagline: 'Everything, no limits', accent: '#a78bfa', featured: true, badge: 'Most popular', cta: 'Get Pro' },
    max: { name: 'Max', tagline: 'For serious, daily prep', accent: '#22d3ee', cta: 'Get Max' },
}

const TRUST = ['7-day refund', 'Cancel anytime', 'Secure checkout by Razorpay']

const FAQ = [
    ['Can I change plans later?', 'Yes — upgrade or downgrade whenever you like. A new term starts from the day you switch.'],
    ['What happens when my term ends?', 'Nothing auto-renews. You drop back to Free and can re-subscribe any time.'],
    ['How do refunds work?', 'Full refund within 7 days of purchase. See the Refund & Cancellation Policy for details.'],
    ['Which payment methods work?', 'All major Indian cards, UPI and net-banking, handled securely by Razorpay.'],
]

const isInf = (v) => v === Infinity || v === 'unlimited'
const rupees = (paise) => `₹${Math.round((paise || 0) / 100).toLocaleString('en-IN')}`

// Human-readable feature bullets derived from a plan's limits.
function describeLimits(plan) {
    const l = (TIERS[plan] || TIERS.free).limits
    const out = []

    out.push(isInf(l.dsa_catalog_visible) ? 'All DSA problems' : `${l.dsa_catalog_visible} DSA problems`)
    out.push(isInf(l.lld_catalog_visible) ? 'All LLD problems' : `${l.lld_catalog_visible} LLD problems`)
    out.push(l.hld_catalog_access === 'full' ? 'HLD: full access' : 'HLD: list only')

    out.push(
        isInf(l.hld_practice_per_month)
            ? 'Unlimited HLD practice'
            : l.hld_practice_per_month === 0
                ? 'No HLD practice sessions'
                : `${l.hld_practice_per_month} HLD practices / mo`
    )

    out.push(
        isInf(l.interview_q_per_subcategory)
            ? 'Unlimited interview questions'
            : `${l.interview_q_per_subcategory} interview questions per topic`
    )

    out.push(
        isInf(l.resume_optimizer_per_month)
            ? 'Unlimited resume optimizations'
            : l.resume_optimizer_per_month === 0
                ? 'Resume optimizer locked'
                : `${l.resume_optimizer_per_month} resume optimizations / mo`
    )

    out.push(
        isInf(l.ai_explanations_per_month)
            ? 'Unlimited AI explanations'
            : l.ai_explanations_per_month === 0
                ? 'No AI explanations'
                : `${l.ai_explanations_per_month} AI explanations / mo`
    )

    return out
}

export default function PricingPage() {
    const { plan: currentPlan, refetch } = useEntitlements()
    const { user } = useAuth()
    const navigate = useNavigate()
    const [billing, setBilling] = useState('monthly') // 'monthly' | 'yearly'
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
                        One subscription covers DSA, LLD, HLD, interview questions and the AI resume optimizer.
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
                </header>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(258px, 1fr))', gap: 18, alignItems: 'start' }}>
                    {PLAN_ORDER.map((id) => {
                        const meta = PLAN_META[id] || { name: id, accent: '#71717a' }
                        const paise = priceInrPaise(id, billing)
                        const isCurrent = currentPlan === id
                        const bullets = describeLimits(id)
                        const featured = !!meta.featured
                        const yearlyPaise = priceInrPaise(id, 'yearly')
                        const headline = id === 'free'
                            ? '₹0'
                            : billing === 'yearly' ? rupees(yearlyPaise / 12) : rupees(paise)

                        return (
                            <div key={id} style={{
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
                                                : `or ${rupees(yearlyPaise)}/yr — save ${savingsPct(id)}%`}
                                        </div>
                                    )}
                                </div>

                                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
                                    {bullets.map((f) => (
                                        <li key={f} style={{ fontSize: '0.78rem', color: 'var(--accent)', display: 'flex', gap: 8, lineHeight: 1.4 }}>
                                            <span style={{ color: meta.accent, flexShrink: 0 }}>✓</span>{f}
                                        </li>
                                    ))}
                                </ul>

                                <button
                                    onClick={() => {
                                        if (isCurrent || id === 'free' || pending) return
                                        startCheckout(id)
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
                    })}
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
                    Prices in INR, billed by Razorpay. Payments are one-time for the selected term — nothing auto-renews.
                    See our <Link to="/refunds" style={{ color: 'var(--pop)' }}>Refund &amp; Cancellation Policy</Link>.
                </p>
                <p style={{ textAlign: 'center', marginTop: 12 }}>
                    <Link to="/" style={{ color: 'var(--pop)', fontSize: '0.8rem', textDecoration: 'none' }}>← Back</Link>
                </p>
            </main>
        </>
    )
}

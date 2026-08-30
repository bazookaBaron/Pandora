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
    free: { name: 'Free', tagline: 'Get a feel for it', accent: '#71717a' },
    pro: { name: 'Pro', tagline: 'Everything, no limits', accent: '#a78bfa', featured: true },
    max: { name: 'Max', tagline: 'For serious prep', accent: '#22d3ee' },
}

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
            <main className="wrap" style={{ maxWidth: 980, margin: '0 auto', padding: '72px 16px 32px' }}>
                <header style={{ textAlign: 'center', marginBottom: 22 }}>
                    <h1 style={{ fontSize: '1.4rem', fontWeight: 900, color: 'var(--bright)', letterSpacing: '-0.03em' }}>Pricing</h1>
                    <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: 6 }}>
                        Pick the plan that fits your prep. Cancel anytime.
                    </p>

                    {/* Monthly / yearly toggle */}
                    <div className="profile-segment" role="group" aria-label="Billing period" style={{ margin: '16px auto 0' }}>
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
                </header>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
                    {PLAN_ORDER.map((id) => {
                        const meta = PLAN_META[id] || { name: id, accent: '#71717a' }
                        const paise = priceInrPaise(id, billing)
                        const period = billing === 'yearly' ? '/yr' : '/mo'
                        const isCurrent = currentPlan === id
                        const bullets = describeLimits(id)

                        return (
                            <div key={id} style={{
                                background: 'var(--panel)',
                                border: `1px solid ${meta.featured ? meta.accent + '66' : 'var(--subtle)'}`,
                                borderRadius: 14, padding: '22px 20px', display: 'flex', flexDirection: 'column', gap: 14,
                                position: 'relative',
                            }}>
                                {isCurrent && (
                                    <span style={{
                                        position: 'absolute', top: 14, right: 14, fontSize: '0.6rem', fontWeight: 900,
                                        textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--surface)',
                                        background: meta.accent, borderRadius: 6, padding: '3px 8px',
                                    }}>
                                        Current
                                    </span>
                                )}

                                <div>
                                    <div style={{ fontSize: '0.7rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: meta.accent }}>{meta.name}</div>
                                    <div style={{ marginTop: 6 }}>
                                        <span style={{ fontSize: '1.8rem', fontWeight: 900, color: 'var(--bright)' }}>{id === 'free' ? '₹0' : rupees(paise)}</span>
                                        {paise > 0 && <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{period}</span>}
                                    </div>
                                    <div style={{ color: 'var(--muted)', fontSize: '0.76rem', marginTop: 2 }}>{meta.tagline}</div>
                                </div>

                                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
                                    {bullets.map((f) => (
                                        <li key={f} style={{ fontSize: '0.78rem', color: 'var(--accent)', display: 'flex', gap: 8 }}>
                                            <span style={{ color: meta.accent }}>✓</span>{f}
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
                                        marginTop: 'auto', padding: '10px 16px', borderRadius: 8, border: 'none',
                                        cursor: (isCurrent || id === 'free' || pending === id) ? 'default' : 'pointer', fontWeight: 900, fontSize: '0.78rem',
                                        textTransform: 'uppercase', letterSpacing: '0.06em',
                                        opacity: pending === id ? 0.7 : 1,
                                        background: isCurrent ? 'var(--subtle)' : id === 'free' ? 'var(--subtle)' : meta.featured ? 'linear-gradient(135deg, #22d3ee, #a78bfa)' : 'var(--subtle)',
                                        color: isCurrent ? 'var(--muted)' : id === 'free' ? 'var(--muted)' : meta.featured ? 'var(--surface)' : 'var(--bright)',
                                    }}
                                >
                                    {pending === id ? 'Starting…' : isCurrent ? 'Current plan' : id === 'free' ? 'Free forever' : `Upgrade to ${meta.name}`}
                                </button>
                            </div>
                        )
                    })}
                </div>

                {note && (
                    <ErrorState compact title="Checkout" message={note} style={{ marginTop: 18 }} />
                )}

                <p style={{ textAlign: 'center', marginTop: 20, fontSize: '0.72rem', color: 'var(--faint)' }}>
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

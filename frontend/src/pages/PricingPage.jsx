import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { TIERS, PLAN_ORDER } from '../../config/tiers.js'
import { useEntitlements } from '../lib/useEntitlements'
import { apiFetch, ApiError } from '../lib/apiClient'
import { ErrorState } from '../components/shared/states'
import { track, EVENTS } from '../lib/analytics'

// ── Pricing (config-driven) ─────────────────────────────────────────
// Renders Free / Pro / Max straight from `config/tiers.js`. The Pro/Max CTAs
// call POST /api/checkout and redirect to the hosted Lemon Squeezy checkout;
// on return (?checkout=success) we show a banner and re-poll entitlements to
// catch the webhook that activates the plan.

const PLAN_META = {
    free: { name: 'Free', tagline: 'Get a feel for it', accent: '#71717a' },
    pro: { name: 'Pro', tagline: 'Everything, no limits', accent: '#a78bfa', featured: true },
    max: { name: 'Max', tagline: 'For serious prep', accent: '#22d3ee' },
}

const isInf = (v) => v === Infinity || v === 'unlimited'
const dollars = (cents) => `$${Math.round((cents || 0) / 100)}`

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
    const [billing, setBilling] = useState('monthly') // 'monthly' | 'yearly'
    const [note, setNote] = useState('')
    const [pending, setPending] = useState('') // plan id currently starting checkout
    const [searchParams, setSearchParams] = useSearchParams()
    const checkoutSuccess = searchParams.get('checkout') === 'success'

    useEffect(() => {
        track(EVENTS.PRICING_VIEWED)
    }, [])

    // Returning from a successful checkout: the webhook that flips the plan may
    // lag the browser redirect, so refetch now and once more after a beat, then
    // strip the query param so a refresh doesn't replay the banner.
    useEffect(() => {
        if (!checkoutSuccess) return
        refetch()
        const t = setTimeout(() => refetch(), 4000)
        const next = new URLSearchParams(searchParams)
        next.delete('checkout')
        setSearchParams(next, { replace: true })
        return () => clearTimeout(t)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [checkoutSuccess])

    async function startCheckout(plan) {
        setNote('')
        setPending(plan)
        track(EVENTS.CHECKOUT_STARTED, { plan, billing })
        try {
            const { url } = await apiFetch('/api/checkout', { json: { plan, billingPeriod: billing } })
            window.location.href = url
        } catch (err) {
            if (err instanceof ApiError && err.code === 'checkout_unconfigured') {
                setNote('Checkout isn’t connected yet. To test, set your plan in Supabase.')
            } else if (err && err.status === 401) {
                setNote('Please sign in first.')
            } else {
                setNote('Could not start checkout — try again.')
            }
            setPending('')
        }
    }

    return (
        <>
            <Navbar />
            <main className="wrap" style={{ maxWidth: 980, margin: '0 auto', padding: '72px 16px 32px' }}>
                {checkoutSuccess && (
                    <p style={{
                        textAlign: 'center', marginBottom: 18, fontSize: '0.8rem', color: '#4ade80',
                        background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.25)',
                        borderRadius: 8, padding: '10px 14px',
                    }}>
                        Payment received — your plan will activate shortly.
                    </p>
                )}
                <header style={{ textAlign: 'center', marginBottom: 22 }}>
                    <h1 style={{ fontSize: '1.4rem', fontWeight: 900, color: '#fafafa', letterSpacing: '-0.03em' }}>Pricing</h1>
                    <p style={{ color: '#71717a', fontSize: '0.85rem', marginTop: 6 }}>
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
                        const price = TIERS[id].price
                        const cents = billing === 'yearly' ? price.yearly : price.monthly
                        const period = billing === 'yearly' ? '/yr' : '/mo'
                        const isCurrent = currentPlan === id
                        const bullets = describeLimits(id)

                        return (
                            <div key={id} style={{
                                background: '#18181b',
                                border: `1px solid ${meta.featured ? meta.accent + '66' : '#27272a'}`,
                                borderRadius: 14, padding: '22px 20px', display: 'flex', flexDirection: 'column', gap: 14,
                                position: 'relative',
                            }}>
                                {isCurrent && (
                                    <span style={{
                                        position: 'absolute', top: 14, right: 14, fontSize: '0.6rem', fontWeight: 900,
                                        textTransform: 'uppercase', letterSpacing: '0.08em', color: '#09090b',
                                        background: meta.accent, borderRadius: 6, padding: '3px 8px',
                                    }}>
                                        Current
                                    </span>
                                )}

                                <div>
                                    <div style={{ fontSize: '0.7rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: meta.accent }}>{meta.name}</div>
                                    <div style={{ marginTop: 6 }}>
                                        <span style={{ fontSize: '1.8rem', fontWeight: 900, color: '#fafafa' }}>{dollars(cents)}</span>
                                        {cents > 0 && <span style={{ color: '#71717a', fontSize: '0.8rem' }}>{period}</span>}
                                    </div>
                                    <div style={{ color: '#71717a', fontSize: '0.76rem', marginTop: 2 }}>{meta.tagline}</div>
                                </div>

                                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
                                    {bullets.map((f) => (
                                        <li key={f} style={{ fontSize: '0.78rem', color: '#a1a1aa', display: 'flex', gap: 8 }}>
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
                                        background: isCurrent ? '#27272a' : id === 'free' ? '#27272a' : meta.featured ? 'linear-gradient(135deg, #22d3ee, #a78bfa)' : '#27272a',
                                        color: isCurrent ? '#71717a' : id === 'free' ? '#71717a' : meta.featured ? '#09090b' : '#fafafa',
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

                <p style={{ textAlign: 'center', marginTop: 24 }}>
                    <Link to="/" style={{ color: '#22d3ee', fontSize: '0.8rem', textDecoration: 'none' }}>← Back</Link>
                </p>
            </main>
        </>
    )
}

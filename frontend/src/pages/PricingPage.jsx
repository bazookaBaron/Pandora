import { Link } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { useTier } from '../lib/useTier'

// Stub pricing page — wire a real checkout (Stripe / Razorpay / …) here later.
// The "Choose Pro" button currently just flips the local tier so the full app
// is browsable; replace onClick with the payment redirect when billing is ready.
const PLANS = [
    {
        id: 'free', name: 'Free', price: '$0', tagline: 'Get a feel for it',
        features: ['5 DSA problems', '3 LLD problems', '3 HLD questions', 'Resume optimizer locked'],
        accent: '#71717a',
    },
    {
        id: 'pro', name: 'Pro', price: '$9', period: '/mo', tagline: 'Everything, no limits',
        features: ['All DSA problems + pagination', 'All LLD problems', 'All HLD questions', 'Full resume optimizer', 'Whiteboard + AI design review'],
        accent: '#a78bfa', featured: true,
    },
]

export default function PricingPage() {
    const { tier, setTier } = useTier()

    return (
        <>
            <Navbar />
            <main className="wrap" style={{ maxWidth: 860, margin: '0 auto', padding: '32px 16px' }}>
                <header style={{ textAlign: 'center', marginBottom: 28 }}>
                    <h1 style={{ fontSize: '1.4rem', fontWeight: 900, color: '#fafafa', letterSpacing: '-0.03em' }}>Pricing</h1>
                    <p style={{ color: '#71717a', fontSize: '0.85rem', marginTop: 6 }}>
                        Currently a preview — the checkout isn’t wired yet. Selecting a plan just switches your local view.
                    </p>
                </header>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
                    {PLANS.map((p) => {
                        const active = tier === p.id
                        return (
                            <div key={p.id} style={{
                                background: '#18181b',
                                border: `1px solid ${p.featured ? p.accent + '66' : '#27272a'}`,
                                borderRadius: 14, padding: '22px 20px', display: 'flex', flexDirection: 'column', gap: 14,
                            }}>
                                <div>
                                    <div style={{ fontSize: '0.7rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', color: p.accent }}>{p.name}</div>
                                    <div style={{ marginTop: 6 }}>
                                        <span style={{ fontSize: '1.8rem', fontWeight: 900, color: '#fafafa' }}>{p.price}</span>
                                        {p.period && <span style={{ color: '#71717a', fontSize: '0.8rem' }}>{p.period}</span>}
                                    </div>
                                    <div style={{ color: '#71717a', fontSize: '0.76rem', marginTop: 2 }}>{p.tagline}</div>
                                </div>
                                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
                                    {p.features.map((f) => (
                                        <li key={f} style={{ fontSize: '0.78rem', color: '#a1a1aa', display: 'flex', gap: 8 }}>
                                            <span style={{ color: p.accent }}>✓</span>{f}
                                        </li>
                                    ))}
                                </ul>
                                <button
                                    onClick={() => setTier(p.id)}
                                    disabled={active}
                                    style={{
                                        marginTop: 'auto', padding: '10px 16px', borderRadius: 8, border: 'none',
                                        cursor: active ? 'default' : 'pointer', fontWeight: 900, fontSize: '0.78rem',
                                        textTransform: 'uppercase', letterSpacing: '0.06em',
                                        background: active ? '#27272a' : p.featured ? 'linear-gradient(135deg, #22d3ee, #a78bfa)' : '#27272a',
                                        color: active ? '#71717a' : p.featured ? '#09090b' : '#fafafa',
                                    }}
                                >
                                    {active ? 'Current plan' : `Switch to ${p.name}`}
                                </button>
                            </div>
                        )
                    })}
                </div>

                <p style={{ textAlign: 'center', marginTop: 24 }}>
                    <Link to="/" style={{ color: '#22d3ee', fontSize: '0.8rem', textDecoration: 'none' }}>← Back</Link>
                </p>
            </main>
        </>
    )
}

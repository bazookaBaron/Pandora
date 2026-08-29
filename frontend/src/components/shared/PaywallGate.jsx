import { Link } from 'react-router-dom'

// ── Paywall primitives ──────────────────────────────────────────────
// Compose these on any list/page to gate content for free-tier users.
//
// SECURITY MODEL: these components render their OWN generic skeletons.
// They never accept or blur real data. The rule is: locked content must
// never reach the browser on free tier — the list-page queries fetch only
// the allowed rows (`.limit(limits.X)`) plus a lightweight count for the
// "N of TOTAL" copy. `LockedSlice` is purely a decorative "there's more
// behind the paywall" affordance; it contains no titles/companies/slugs.
//
//   const { isFree, limits } = useTier()
//   // free query: .limit(limits.lld); separate ['lld-count'] head query -> total
//   ...render the <= limits.lld allowed rows...
//   {isFree && total > limits.lld && (
//     <LockedSlice count={total - limits.lld} noun="LLD problems" variant="card" />
//   )}
//
// For a whole page (e.g. resume optimizer): render <LockedPanel .../> with
// NO children instead of the page body, so the real UI is never in the DOM.

function LockIcon({ size = 22 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
    )
}

export function UpgradeButton({ children = 'Unlock Pro', size = 'md' }) {
    const pad = size === 'sm' ? '6px 14px' : '10px 22px'
    const fs = size === 'sm' ? '0.72rem' : '0.82rem'
    return (
        <Link
            to="/pricing"
            style={{
                display: 'inline-flex', alignItems: 'center', gap: 8, padding: pad,
                borderRadius: 8, textDecoration: 'none',
                background: 'linear-gradient(135deg, #22d3ee, #a78bfa)',
                color: '#09090b', fontWeight: 900, fontSize: fs,
                textTransform: 'uppercase', letterSpacing: '0.06em',
                boxShadow: '0 4px 20px rgba(34,211,238,0.25)',
            }}
        >
            <LockIcon size={14} />
            {children}
        </Link>
    )
}

// ── Generic skeleton building blocks (NO real data) ─────────────────
function Bar({ w = '100%', h = 12, r = 4 }) {
    return (
        <div style={{
            width: w, height: h, borderRadius: r, background: '#27272a',
            animation: 'pulse 1.5s ease-in-out infinite',
        }} />
    )
}

const BAR_WIDTHS = ['92%', '64%', '81%', '54%', '73%', '60%', '88%', '48%']

function SkeletonCard({ i = 0 }) {
    return (
        <div style={{
            background: '#18181b', border: '1px solid #27272a', borderRadius: 8,
            padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
        }}>
            <Bar w={18} h={18} r={4} />
            <Bar w={BAR_WIDTHS[i % BAR_WIDTHS.length]} h={14} />
            <Bar w="100%" h={9} />
            <Bar w={BAR_WIDTHS[(i + 3) % BAR_WIDTHS.length]} h={9} />
            <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                <Bar w={18} h={18} r={4} />
                <Bar w={18} h={18} r={4} />
                <Bar w={18} h={18} r={4} />
            </div>
        </div>
    )
}

function SkeletonRow({ i = 0 }) {
    return (
        <div style={{
            display: 'grid', gridTemplateColumns: '28px 1fr 90px 1fr',
            gap: 8, padding: '12px', alignItems: 'center',
            borderBottom: '1px solid rgba(39,39,42,0.5)',
        }}>
            <Bar w={20} h={20} r={4} />
            <Bar w={BAR_WIDTHS[i % BAR_WIDTHS.length]} h={13} />
            <Bar w={58} h={13} />
            <Bar w={BAR_WIDTHS[(i + 2) % BAR_WIDTHS.length]} h={13} />
        </div>
    )
}

function Skeleton({ rows = 4, variant = 'row' }) {
    const items = Array.from({ length: Math.max(1, rows) })
    if (variant === 'card') {
        return (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
                {items.map((_, i) => <SkeletonCard key={i} i={i} />)}
            </div>
        )
    }
    return <div>{items.map((_, i) => <SkeletonRow key={i} i={i} />)}</div>
}

// Blurred "more content is locked" affordance shown after the allowed rows.
// Renders its OWN grey skeleton — never real data. `count` + `noun` drive the
// headline; `rows` / `variant` only tweak the decorative skeleton shape.
export function LockedSlice({ count, noun = 'items', rows = 4, variant = 'row', maxHeight = 260 }) {
    return (
        <div style={{ position: 'relative', marginTop: 4 }}>
            <div aria-hidden style={{
                filter: 'blur(5px)', pointerEvents: 'none', userSelect: 'none',
                opacity: 0.5, maxHeight, overflow: 'hidden',
                maskImage: 'linear-gradient(to bottom, #000 0%, #000 40%, transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, #000 0%, #000 40%, transparent 100%)',
            }}>
                <Skeleton rows={rows} variant={variant} />
            </div>
            <div style={{
                position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 10, textAlign: 'center', padding: 20,
            }}>
                <div style={{ color: '#a78bfa' }}><LockIcon /></div>
                <p style={{ margin: 0, color: '#fafafa', fontWeight: 900, fontSize: '0.95rem' }}>
                    {count > 0 ? `${count} more ${noun} locked` : `More ${noun} locked`}
                </p>
                <p style={{ margin: 0, color: '#71717a', fontSize: '0.78rem', maxWidth: 320 }}>
                    Free tier shows a preview. Upgrade to unlock everything and remove limits.
                </p>
                <UpgradeButton />
            </div>
        </div>
    )
}

// Fully lock a panel/page body (e.g. the resume optimizer for free users).
// Callers should pass NO children — the real UI must stay out of the DOM.
// A generic blurred skeleton renders behind the message by default; passing
// `children` (legacy) blurs them instead.
export function LockedPanel({
    children,
    title = 'This is a Pro feature',
    subtitle = 'Upgrade to unlock the full resume optimizer.',
    minHeight = 420,
}) {
    return (
        <div style={{ position: 'relative', minHeight }}>
            <div aria-hidden style={{
                filter: 'blur(8px)', pointerEvents: 'none', userSelect: 'none', opacity: 0.4,
            }}>
                {children != null ? children : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        <div style={{ height: 88, background: '#18181b', border: '1px solid #27272a', borderRadius: 10 }} />
                        <div style={{ height: 132, background: '#18181b', border: '1px solid #27272a', borderRadius: 10 }} />
                        <div style={{ height: 200, background: '#18181b', border: '1px solid #27272a', borderRadius: 10 }} />
                        <div style={{ height: 44, background: '#27272a', borderRadius: 8 }} />
                    </div>
                )}
            </div>
            <div style={{
                position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 14, textAlign: 'center', padding: 32,
            }}>
                <div style={{
                    width: 56, height: 56, borderRadius: 14, display: 'flex', alignItems: 'center',
                    justifyContent: 'center', color: '#09090b',
                    background: 'linear-gradient(135deg, #22d3ee, #a78bfa)',
                }}>
                    <LockIcon size={26} />
                </div>
                <h2 style={{ margin: 0, color: '#fafafa', fontWeight: 900, fontSize: '1.1rem', letterSpacing: '-0.02em' }}>
                    {title}
                </h2>
                <p style={{ margin: 0, color: '#a1a1aa', fontSize: '0.85rem', maxWidth: 380, lineHeight: 1.6 }}>
                    {subtitle}
                </p>
                <UpgradeButton>Unlock Pro</UpgradeButton>
            </div>
        </div>
    )
}

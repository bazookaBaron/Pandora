import { Link } from 'react-router-dom'
import { UsageMeter, UpgradeButton } from './PaywallGate'

// ── Reusable UX states (dark-mono) ─────────────────────────────────
// One place for loading / error / empty / usage-limit presentation so every
// list + workspace page reads the same. All components take `style` /
// `className` passthrough and a `compact` flag (smaller, for inline use next
// to a control) vs the default full-panel treatment.
//
// Tokens: --surface #09090b · --panel #18181b · --subtle #27272a
//         --pop #22d3ee · --warm #f472b6 · --muted #71717a · --bright #fafafa

// ── errorText(err) ────────────────────────────────────────────────
// Map an ApiError (or any thrown value) to one short, human sentence. Never
// dumps a stack. Exported so callers can pass `message={errorText(err)}` when
// they want to compose their own layout.
export function errorText(err) {
    if (!err) return 'Unexpected error.'
    if (err.code === 'network') return "Can't reach the server. Check your connection."
    if (err.status === 429) return "You're doing that too fast — wait a moment."
    if (err.status >= 500 || err.code === 'AI service error') {
        return 'The service is temporarily unavailable. Try again in a moment.'
    }
    if (err.status === 401 || err.code === 'auth required') {
        return 'Your session expired. Please sign in again.'
    }
    return err.message || 'Unexpected error.'
}

function isAuthErr(err) {
    return !!err && (err.status === 401 || err.code === 'auth required')
}

// Relative "Resets …" copy — mirrors PaywallGate.formatResetDate.
function formatResetDate(iso) {
    if (!iso) return ''
    const then = new Date(iso).getTime()
    if (Number.isNaN(then)) return ''
    const days = Math.round((then - Date.now()) / 86400000)
    if (days <= 0) return 'soon'
    if (days === 1) return 'tomorrow'
    if (days < 30) return `in ${days} days`
    return `on ${new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

// ── LoadingState ─────────────────────────────────────────────────
export function LoadingState({ label = 'Loading…', compact = false, style, className }) {
    const spinner = (
        <div style={{
            width: compact ? 13 : 22,
            height: compact ? 13 : 22,
            borderRadius: '50%',
            border: '2px solid #27272a',
            borderTopColor: '#22d3ee',
            animation: 'spin 0.7s linear infinite',
            flexShrink: 0,
        }} />
    )

    if (compact) {
        return (
            <div className={className} style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#71717a', fontSize: '0.78rem', ...style }}>
                {spinner}
                {label && <span>{label}</span>}
            </div>
        )
    }

    return (
        <div className={className} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 12, padding: '60px 20px', textAlign: 'center', ...style,
        }}>
            {spinner}
            {label && <span style={{ color: '#71717a', fontSize: '0.82rem' }}>{label}</span>}
        </div>
    )
}

// ── ErrorState ───────────────────────────────────────────────────
// Pass `err` (an ApiError) and it derives the message + picks the right
// action: a "Sign in" link for a 401, a "Retry" button when `onRetry` is
// given. `message` overrides the derived text.
export function ErrorState({
    title = 'Something went wrong',
    message,
    err = null,
    onRetry,
    compact = false,
    style,
    className,
}) {
    const auth = isAuthErr(err)
    const text = message != null ? message : (err ? errorText(err) : null)

    const retryBtn = onRetry && !auth && (
        <button
            onClick={onRetry}
            style={{
                padding: compact ? '5px 14px' : '7px 18px', background: 'none',
                border: '1px solid #27272a', borderRadius: 6, color: '#22d3ee',
                cursor: 'pointer', fontSize: '0.78rem', fontWeight: 700,
            }}
        >
            Retry
        </button>
    )

    const signInBtn = auth && (
        <Link
            to="/auth"
            style={{
                display: 'inline-block', padding: compact ? '5px 14px' : '7px 18px',
                background: 'none', border: '1px solid #27272a', borderRadius: 6,
                color: '#f472b6', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 700,
                textDecoration: 'none',
            }}
        >
            Sign in
        </Link>
    )

    if (compact) {
        return (
            <div className={className} style={{
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                padding: '10px 12px', background: 'rgba(248,113,113,0.08)',
                border: '1px solid rgba(248,113,113,0.35)', borderRadius: 6, ...style,
            }}>
                <span aria-hidden style={{ flexShrink: 0 }}>⚠️</span>
                <span style={{ fontSize: '0.76rem', color: '#f87171', flex: 1, minWidth: 140 }}>
                    {text || title}
                </span>
                {retryBtn}
                {signInBtn}
            </div>
        )
    }

    return (
        <div className={className} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 10, padding: '60px 20px', textAlign: 'center', ...style,
        }}>
            <div aria-hidden style={{ fontSize: '2rem' }}>⚠️</div>
            <p style={{ margin: 0, color: '#fafafa', fontWeight: 900, fontSize: '0.95rem' }}>{title}</p>
            {text && (
                <p style={{ margin: 0, color: '#a1a1aa', fontSize: '0.8rem', maxWidth: 380, lineHeight: 1.6 }}>
                    {text}
                </p>
            )}
            {(retryBtn || signInBtn) && (
                <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>{retryBtn}{signInBtn}</div>
            )}
            <p style={{ margin: '4px 0 0', color: '#52525b', fontSize: '0.72rem' }}>
                If this keeps happening, reload the page.
            </p>
        </div>
    )
}

// ── EmptyState ───────────────────────────────────────────────────
// "no results" / "nothing here yet". `icon` + `action` are arbitrary nodes.
export function EmptyState({ icon, title, message, action, compact = false, style, className }) {
    return (
        <div className={className} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 8, padding: compact ? '28px 16px' : '60px 20px', textAlign: 'center', ...style,
        }}>
            {icon != null && (
                <div aria-hidden style={{ fontSize: compact ? '1.5rem' : '2rem', marginBottom: 4 }}>{icon}</div>
            )}
            {title && (
                <p style={{ margin: 0, color: '#71717a', fontSize: compact ? '0.85rem' : '0.9rem' }}>{title}</p>
            )}
            {message && (
                <p style={{ margin: 0, color: '#52525b', fontSize: '0.76rem', maxWidth: 340, lineHeight: 1.6 }}>{message}</p>
            )}
            {action && <div style={{ marginTop: 8 }}>{action}</div>}
        </div>
    )
}

// ── LimitReached ─────────────────────────────────────────────────
// THE monthly-usage paywall. Shows how much of the metered allowance is
// spent, when it resets, and a prominent "Upgrade to Pro" CTA → /pricing.
//   compact  → an inline red-tinted strip (next to a button)
//   default  → a centered card (replaces the ad-hoc 402 notes)
const FEATURE_NOUN = {
    resume_optimizer: 'resume optimizations',
    hld_practice: 'HLD practices',
    ai_explanation: 'AI explanations',
}

export function LimitReached({ feature, used, limit, resetsAt, compact = false, style, className }) {
    const noun = FEATURE_NOUN[feature] || 'uses'
    const finite = limit != null && Number.isFinite(Number(limit))
    const headline = finite
        ? `You've used all ${limit} ${noun} this month`
        : `You've hit this month's ${noun} limit`
    const resetLine = resetsAt ? `Resets ${formatResetDate(resetsAt)}` : ''

    if (compact) {
        return (
            <div className={className} style={{
                display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start',
                padding: '10px 12px', background: 'rgba(248,113,113,0.08)',
                border: '1px solid rgba(248,113,113,0.35)', borderRadius: 6, ...style,
            }}>
                <span style={{ fontSize: '0.72rem', color: '#f87171', fontWeight: 700 }}>{headline}.</span>
                {resetLine && <span style={{ fontSize: '0.66rem', color: '#71717a' }}>{resetLine}.</span>}
                <UpgradeButton size="sm">Upgrade to Pro</UpgradeButton>
            </div>
        )
    }

    return (
        <div className={className} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 12, padding: '32px 24px', textAlign: 'center',
            background: '#18181b', border: '1px solid #27272a', borderRadius: 12, ...style,
        }}>
            <h2 style={{ margin: 0, color: '#fafafa', fontWeight: 900, fontSize: '1.05rem', letterSpacing: '-0.02em' }}>
                {headline}
            </h2>
            {finite && (
                <div style={{ width: '100%', maxWidth: 320 }}>
                    <UsageMeter feature={feature} />
                </div>
            )}
            {resetLine && (
                <p style={{ margin: 0, color: '#71717a', fontSize: '0.78rem' }}>{resetLine}.</p>
            )}
            <UpgradeButton>Upgrade to Pro</UpgradeButton>
        </div>
    )
}

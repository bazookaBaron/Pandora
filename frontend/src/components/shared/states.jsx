import { Link } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import { UsageMeter, UpgradeButton } from './PaywallGate'
import { errorText as libErrorText } from '../../lib/errorText'
import { resetText } from '../../lib/format'
import EmptyArt from '../ui/EmptyArt'

// ── Reusable UX states ─────────────────────────────────────────────
// One place for loading / error / empty / usage-limit presentation so every
// list + workspace page reads the same. All components take `style` /
// `className` passthrough and a `compact` flag (smaller, for inline use next
// to a control) vs the default full-panel treatment.
//
// Colours are tokens only (index.css brand tokens + styles/system.css semantic
// group), so light and dark themes both stay on brand.

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
    return libErrorText(err, 'Unexpected error.')
}

function isAuthErr(err) {
    return !!err && (err.status === 401 || err.code === 'auth required')
}

// ── LoadingState ─────────────────────────────────────────────────
export function LoadingState({ label = 'Loading…', compact = false, style, className }) {
    const spinner = (
        <div aria-hidden="true" style={{
            width: compact ? 13 : 22,
            height: compact ? 13 : 22,
            borderRadius: '50%',
            border: '2px solid var(--subtle)',
            borderTopColor: 'var(--pop)',
            animation: 'spin 0.7s linear infinite',
            flexShrink: 0,
        }} />
    )

    if (compact) {
        return (
            <div className={className} role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: '0.78rem', ...style }}>
                {spinner}
                {label ? <span>{label}</span> : <span className="sys-sr">Loading</span>}
            </div>
        )
    }

    return (
        <div className={className} role="status" aria-live="polite" style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 12, padding: '60px 20px', textAlign: 'center', ...style,
        }}>
            {spinner}
            {label ? <span style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>{label}</span> : <span className="sys-sr">Loading</span>}
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
        <button type="button" onClick={onRetry} className="sys-btn">Retry</button>
    )

    const signInBtn = auth && (
        <Link to="/auth" className="sys-btn is-warm">Sign in</Link>
    )

    if (compact) {
        return (
            <div className={`tone-danger ${className || ''}`.trim()} role="alert" style={{
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                padding: '10px 12px', background: 'var(--tone-dim)',
                border: '1px solid color-mix(in srgb, var(--tone) 35%, transparent)', borderRadius: 6, ...style,
            }}>
                <AlertTriangle size={15} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--tone)' }} />
                <span style={{ fontSize: '0.76rem', color: 'var(--tone)', flex: 1, minWidth: 140 }}>
                    {text || title}
                </span>
                {retryBtn}
                {signInBtn}
            </div>
        )
    }

    return (
        <div className={`tone-danger ${className || ''}`.trim()} role="alert" style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 10, padding: '60px 20px', textAlign: 'center', ...style,
        }}>
            <span aria-hidden="true" style={{
                display: 'inline-grid', placeItems: 'center', width: 44, height: 44, borderRadius: 12,
                color: 'var(--tone)', background: 'var(--tone-dim)', border: '1px solid color-mix(in srgb, var(--tone) 35%, transparent)',
            }}>
                <AlertTriangle size={22} />
            </span>
            <p style={{ margin: 0, color: 'var(--bright)', fontWeight: 900, fontSize: '0.95rem' }}>{title}</p>
            {text && (
                <p style={{ margin: 0, color: 'var(--accent)', fontSize: '0.8rem', maxWidth: 380, lineHeight: 1.6 }}>
                    {text}
                </p>
            )}
            {(retryBtn || signInBtn) && (
                <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>{retryBtn}{signInBtn}</div>
            )}
            <p style={{ margin: '4px 0 0', color: 'var(--faint)', fontSize: '0.72rem' }}>
                If this keeps happening, reload the page.
            </p>
        </div>
    )
}

// ── EmptyState ───────────────────────────────────────────────────
// "no results" / "nothing here yet".
//   art  = an EmptyArt kind ('search', 'jobs', 'doc', 'questions', 'lock', 'people', 'code', 'diagram', …)
//   tone = colour of the illustration (default 'history')
//   icon = legacy: a React node renders as-is; an emoji string is mapped to an EmptyArt kind (no emoji is shown)
//   action = any node (usually a <Button>)
//
//   <EmptyState art="search" title="No problems match" message="Try a different filter." action={<Button onClick={reset}>Clear filters</Button>} />
const EMOJI_ART = {
    '🔍': 'search', '🔎': 'search', '📄': 'doc', '📝': 'doc', '📃': 'doc', '💬': 'questions', '❓': 'questions',
    '💼': 'jobs', '📭': 'inbox', '📬': 'inbox', '🔒': 'lock', '👥': 'people', '🤝': 'referrals', '📊': 'stats',
    '📈': 'stats', '💻': 'code', '🧩': 'diagram', '🔔': 'bell', '⚠️': 'error',
}

export function EmptyState({ icon, art, tone = 'history', title, message, action, compact = false, style, className }) {
    let visual = null
    if (art) visual = <EmptyArt kind={art} tone={tone} size={compact ? 40 : 56} />
    else if (typeof icon === 'string') visual = <EmptyArt kind={EMOJI_ART[icon.trim()] || 'search'} tone={tone} size={compact ? 40 : 56} />
    else if (icon != null) visual = icon

    return (
        <div className={className} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 8, padding: compact ? '28px 16px' : '60px 20px', textAlign: 'center', ...style,
        }}>
            {visual != null && (
                <div aria-hidden="true" style={{ fontSize: compact ? '1.5rem' : '2rem', marginBottom: 4 }}>{visual}</div>
            )}
            {title && (
                <p style={{ margin: 0, color: 'var(--muted)', fontSize: compact ? '0.85rem' : '0.9rem' }}>{title}</p>
            )}
            {message && (
                <p style={{ margin: 0, color: 'var(--faint)', fontSize: '0.76rem', maxWidth: 340, lineHeight: 1.6 }}>{message}</p>
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
    const resetLine = resetsAt ? `Resets ${resetText(resetsAt)}` : ''

    if (compact) {
        return (
            <div className={`tone-danger ${className || ''}`.trim()} role="status" style={{
                display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start',
                padding: '10px 12px', background: 'var(--tone-dim)',
                border: '1px solid color-mix(in srgb, var(--tone) 35%, transparent)', borderRadius: 6, ...style,
            }}>
                <span style={{ fontSize: '0.72rem', color: 'var(--tone)', fontWeight: 700 }}>{headline}.</span>
                {resetLine && <span style={{ fontSize: '0.66rem', color: 'var(--muted)' }}>{resetLine}.</span>}
                <UpgradeButton size="sm">Upgrade to Pro</UpgradeButton>
            </div>
        )
    }

    return (
        <div className={className} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 12, padding: '32px 24px', textAlign: 'center',
            background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 12, ...style,
        }}>
            <h2 style={{ margin: 0, color: 'var(--bright)', fontWeight: 900, fontSize: '1.05rem', letterSpacing: '-0.02em' }}>
                {headline}
            </h2>
            {finite && (
                <div style={{ width: '100%', maxWidth: 320 }}>
                    <UsageMeter feature={feature} />
                </div>
            )}
            {resetLine && (
                <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.78rem' }}>{resetLine}.</p>
            )}
            <UpgradeButton>Upgrade to Pro</UpgradeButton>
        </div>
    )
}

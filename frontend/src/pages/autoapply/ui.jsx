import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Check, Copy } from 'lucide-react'
import Navbar from '../../components/Navbar'
import { ErrorState, LoadingState } from '../../components/shared/states'
import { useAutoApplyMe, useInboxUnread, useNeedsYou } from '../../lib/useAutoApply'
import { AUTO_APPLY } from '../../../config/tiers.js'
import './autoapply.css'
import { toast } from '../../lib/toast'

// ── shared bits for every AutoApply screen ──────────────────────────

export const rupees = (paise) => `₹${Math.round((Number(paise) || 0) / 100).toLocaleString('en-IN')}`
export const num = (n) => (Number(n) || 0).toLocaleString('en-IN')

export function fmtDate(iso, withTime = true) {
    if (!iso) return '—'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleString('en-IN', withTime
        ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
        : { day: 'numeric', month: 'short', year: 'numeric' })
}

export function fmtAgo(iso) {
    if (!iso) return ''
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
    if (Number.isNaN(s)) return ''
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.floor(s / 60)} min ago`
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`
    return `${Math.floor(s / 86400)} d ago`
}

export const PACK_SIZES = [50, 100]

// Prices come from the API (GET /me -> config.packs, what the server charges); before /me has
// loaded, or when signed out (pricing page), the same shared config/tiers.js the server reads.
export function packPrice(config, kind, size) {
    const fromApi = config?.packs?.[kind]?.[size] ?? config?.packs?.[kind]?.[String(size)]
    if (fromApi != null) return Number(fromApi)
    const fallback = AUTO_APPLY.packs?.[kind]?.[size]
    return Number.isInteger(fallback) ? fallback : null
}

export const PACK_KINDS = {
    service: {
        name: 'Service-based companies',
        short: 'Service',
        blurb: 'IT services, consulting and outsourcing firms.',
    },
    product: {
        name: 'Product-based companies',
        short: 'Product',
        blurb: 'Companies that build their own products.',
    },
}

// ── status pills ────────────────────────────────────────────────────
const BATCH_STATUS = {
    pending_payment: ['Awaiting payment', 't-muted'],
    paid: ['Paid', 't-pop', true],
    shortlisting: ['Shortlisting', 't-pop', true],
    review: ['In review', 't-amber'],
    running: ['Running', 't-green', true],
    paused: ['Paused', 't-amber'],
    waiting_supply: ['Waiting for jobs', 't-pop'],
    waiting_profile: ['Waiting for your profile', 't-warm'],
    completed: ['Completed', 't-green'],
    expired: ['Expired', 't-muted'],
    refund_due: ['Refund pending', 't-warm'],
    refunding: ['Refund in progress', 't-warm'],
    refunded: ['Refunded', 't-muted'],
    cancelled: ['Cancelled', 't-muted'],
}

const TASK_STATUS = {
    shortlisted: ['Shortlisted', 't-pop'],
    removed: ['Removed', 't-muted'],
    queued: ['Queued', 't-pop'],
    claimed: ['Starting', 't-pop', true],
    running: ['Applying', 't-green', true],
    waiting_code: ['Waiting for code', 't-amber', true],
    submitting: ['Submitting', 't-green', true],
    applied: ['Applied', 't-green'],
    skipped: ['Skipped', 't-muted'],
    failed: ['Failed', 't-red'],
    needs_you: ['Needs you', 't-warm'],
    cancelled: ['Cancelled', 't-muted'],
}

export const TASK_STATUS_ORDER = Object.keys(TASK_STATUS)
export const taskStatusLabel = (s) => (TASK_STATUS[s] || [s])[0]
export const ACTIVE_BATCH = ['paid', 'shortlisting', 'review', 'running', 'paused', 'waiting_supply', 'waiting_profile']

// ── profile gate (missing items from /me profile_check, aa_batches.waiting_detail or a 'profile' needs-you item) ──
// missing key -> SetupPage step that fixes it (fields.* / facts.* / profile items are on the answers step)
const STEP_FOR = { onboarding: 'consent', resume: 'resume', email: 'email' }
export const setupStepFor = (key) => STEP_FOR[key] || 'answers'
export function setupLinkFor(missing) {
    const first = Array.isArray(missing) && missing[0]
    const key = first && (typeof first === 'object' ? first.key : first)
    return key ? `/autoapply/account?step=${setupStepFor(key)}` : '/autoapply/account'
}
const missingLabel = (m) => (typeof m === 'object' && m ? m.label || m.key : String(m))

export function ProfileMissing({ missing, lead = 'We start applying as soon as your profile is complete. Still missing:', cta = 'Complete your profile', style }) {
    const list = Array.isArray(missing) ? missing : []
    return (
        <div className="aa-note is-warn aa-stack" style={style} role="status">
            <span>{lead}</span>
            {list.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {list.map((m, i) => <li key={(m && m.key) || i}>{missingLabel(m)}</li>)}
                </ul>
            )}
            <div><Link to={setupLinkFor(list)} className="aa-btn is-primary">{cta}</Link></div>
        </div>
    )
}

// ── readiness score (/me readiness: same items as the gate, as a percentage) ──
export function ReadinessCard({ readiness, title = 'Profile readiness', compact = false, style }) {
    if (!readiness) return null
    const { ok, pct = 0, missing = [] } = readiness
    return (
        <section className={`aa-card${ok ? '' : ' is-warm'}`} style={style} aria-labelledby="aa-ready-h">
            <div className="aa-spread" style={{ alignItems: 'baseline' }}>
                <h2 id="aa-ready-h" className="aa-h2" style={{ margin: 0 }}>{title}</h2>
                <span className="aa-stat-value" style={{ fontSize: '1.3rem' }}>{pct}% ready</span>
            </div>
            <div className="aa-progress" role="progressbar" aria-label="Profile readiness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} style={{ marginTop: 10 }}>
                <span style={{ width: `${pct}%` }} />
            </div>
            {ok ? (
                <p className="aa-muted" style={{ margin: '10px 0 0' }}>Your profile is complete. We can apply as soon as a batch starts.</p>
            ) : (
                <>
                    <p className="aa-muted" style={{ margin: '10px 0 6px' }}>
                        {missing.length} item{missing.length === 1 ? '' : 's'} left. A paid batch waits (no credit used) until these are done:
                    </p>
                    <ul className="aa-list" style={{ margin: 0 }}>
                        {(compact ? missing.slice(0, 5) : missing).map((m) => (
                            <li key={m.key} className="aa-spread" style={{ padding: '6px 0', borderBottom: '1px solid var(--subtle)', gap: 10 }}>
                                <span>{m.label}</span>
                                <Link to={m.fix || `/autoapply/account?step=${setupStepFor(m.key)}`} className="aa-btn" aria-label={`Fix: ${m.label}`}>Fix</Link>
                            </li>
                        ))}
                    </ul>
                    {compact && missing.length > 5 && (
                        <p className="aa-faint" style={{ margin: '6px 0 0' }}>and {missing.length - 5} more · <Link to={setupLinkFor(missing)} style={{ color: 'var(--pop)' }}>open setup</Link></p>
                    )}
                </>
            )}
        </section>
    )
}

// ── must-apply companies (<= 10; the server trims / validates again) ──
export const MUST_MAX = 10
export const MUST_MAX_LEN = 80

export function MustCompaniesInput({ value, onChange, suggestions = [], query, onQuery, disabled, idPrefix = 'must' }) {
    const list = Array.isArray(value) ? value : []
    const full = list.length >= MUST_MAX
    function add(raw) {
        const name = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MUST_MAX_LEN)
        if (!name || full || list.some((c) => c.toLowerCase() === name.toLowerCase())) { onQuery(''); return }
        onChange([...list, name])
        onQuery('')
    }
    return (
        <div className="aa-stack" style={{ gap: 8 }}>
            {list.length > 0 && (
                <div className="aa-chips" aria-label="Must-apply companies">
                    {list.map((c) => (
                        <span key={c} className="aa-chip">
                            {c}
                            <button type="button" className="aa-chip-x" onClick={() => onChange(list.filter((x) => x !== c))} disabled={disabled} aria-label={`Remove ${c}`}
                                style={{ marginLeft: 6, background: 'none', border: 0, color: 'inherit', cursor: 'pointer', padding: 0 }}>×</button>
                        </span>
                    ))}
                </div>
            )}
            <div className="aa-row" style={{ gap: 8 }}>
                <input
                    id={`${idPrefix}-input`}
                    className="input-field"
                    style={{ flex: '1 1 220px', minWidth: 0 }}
                    list={`${idPrefix}-suggest`}
                    value={query}
                    maxLength={MUST_MAX_LEN}
                    placeholder={full ? `Up to ${MUST_MAX} companies` : 'Type a company, e.g. Stripe'}
                    disabled={disabled || full}
                    onChange={(e) => onQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(query) } }}
                    aria-label="Add a must-apply company"
                />
                <datalist id={`${idPrefix}-suggest`}>
                    {suggestions.map((s) => <option key={s} value={s} />)}
                </datalist>
                <button type="button" className="aa-btn" onClick={() => add(query)} disabled={disabled || full || !String(query || '').trim()}>Add</button>
            </div>
            <div className="field-hint">{list.length} / {MUST_MAX} · We apply to matching jobs at these companies first, when they have open roles that fit your preferences.</div>
        </div>
    )
}

function Pill({ map, status }) {
    const [label, tone, live] = map[status] || [String(status || 'unknown').replace(/_/g, ' '), 't-muted']
    return (
        <span className={`aa-pill ${tone}`}>
            {live && <span className="aa-dot" aria-hidden />}
            {label}
        </span>
    )
}
export const BatchStatusPill = ({ status }) => <Pill map={BATCH_STATUS} status={status} />
export const TaskStatusPill = ({ status }) => <Pill map={TASK_STATUS} status={status} />

// reason_code -> human sentence (unknown codes are shown de-snaked)
const REASONS = {
    done_by_user: 'You applied yourself',
    dismissed: 'Dismissed',
    expired: 'Timed out waiting for you',
    already_applied: 'Already applied earlier',
    closed: 'Job is closed',
    job_closed: 'Job is closed',
    captcha: 'Blocked by a captcha',
    sso: 'Needs a social sign-in',
    blocked_company: 'Company is on your blocked list',
    low_score: 'Below your minimum match score',
    daily_cap: 'Daily limit reached, will retry',
    company_cap: 'Company limit reached this week',
    site_budget: 'Site busy today, will retry',
    batch_cancelled: 'Batch cancelled',
    removed_by_user: 'You removed it',
}
export const reasonText = (code) => (code ? REASONS[code] || code.replace(/_/g, ' ') : '')

// ── progress bar ────────────────────────────────────────────────────
export function Progress({ used = 0, total = 0, label }) {
    const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
    return (
        <div>
            <div
                className="aa-progress"
                role="progressbar"
                aria-label={label || 'Credits used'}
                aria-valuemin={0}
                aria-valuemax={total || 0}
                aria-valuenow={used || 0}
            >
                <span style={{ width: `${pct}%` }} />
            </div>
            <div className="aa-spread aa-faint" style={{ marginTop: 5 }}>
                <span>{num(used)} / {num(total)} applied</span>
                <span>{pct}%</span>
            </div>
        </div>
    )
}

// ── copy button ─────────────────────────────────────────────────────
export function CopyButton({ text, label = 'Copy', className = 'aa-btn' }) {
    // 'idle' | 'done' | 'error' — the clipboard API rejects on insecure
    // origins, denied permission or an unfocused document
    const [state, setState] = useState('idle')
    useEffect(() => {
        if (state === 'idle') return undefined
        const t = setTimeout(() => setState('idle'), state === 'error' ? 3000 : 1600)
        return () => clearTimeout(t)
    }, [state])
    async function copy() {
        try {
            await navigator.clipboard.writeText(text || '')
            setState('done')
        } catch {
            setState('error')
            toast.error('Could not copy. Select the text and copy it manually.')
        }
    }
    const done = state === 'done'
    return (
        <button type="button" className={className} onClick={copy} disabled={!text}
            aria-label={`${label}${done ? ' (copied)' : state === 'error' ? ' (copy failed)' : ''}`}
            style={state === 'error' ? { color: 'var(--red)' } : undefined}>
            {done ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
            {done ? 'Copied' : state === 'error' ? 'Copy failed' : label}
        </button>
    )
}

// ── inline confirmation (replaces window.confirm) ──────────────────
export function InlineConfirm({ message, confirmLabel = 'Confirm', onConfirm, onCancel, busy, tone = 'danger' }) {
    return (
        <div className={`aa-confirm${tone === 'danger' ? '' : ' is-neutral'}`} role="alertdialog" aria-live="assertive" aria-label={message}>
            <p>{message}</p>
            <button type="button" className={`aa-btn ${tone === 'danger' ? 'is-danger' : 'is-primary'}`} onClick={onConfirm} disabled={busy}>
                {busy ? 'Working…' : confirmLabel}
            </button>
            <button type="button" className="aa-btn" onClick={onCancel} disabled={busy}>Keep it</button>
        </div>
    )
}

// ── sub-navigation ──────────────────────────────────────────────────
const TABS = [
    { to: '/autoapply', label: 'Overview', also: ['/autoapply/batches', '/autoapply/buy', '/autoapply/needs-you'] },
    { to: '/autoapply/inbox', label: 'Inbox', unread: true },
    { to: '/autoapply/account', label: 'Account' },
]

function SubNav({ showBadge }) {
    const { pathname } = useLocation()
    // the unread badge polls only for an eligible (paid) user
    const unread = useInboxUnread({ enabled: !!showBadge })
    const unreadCount = showBadge ? (unread.data?.count || 0) : 0
    return (
        <nav className="aa-subnav" aria-label="AutoApply">
            {TABS.map((t) => {
                const active = t.to === '/autoapply'
                    ? pathname === t.to || t.also.some((p) => pathname.startsWith(p))
                    : pathname.startsWith(t.to)
                return (
                    <Link key={t.to} to={t.to} className={`nav-pill${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}>
                        {t.label}
                        {t.unread && unreadCount > 0 && <span className="aa-count" aria-label={`${unreadCount} unread`}>{unreadCount > 99 ? '99+' : unreadCount}</span>}
                    </Link>
                )
            })}
        </nav>
    )
}

// Page shell: Navbar + sub-nav + main. `gate` = require an eligible (Pro/Max)
// account; free users see the upgrade card instead of `children`.
export function AALayout({ children, gate = false, showNav = true }) {
    const me = useAutoApplyMe()
    const eligible = !!me.data?.eligible
    let body = children
    if (gate) {
        if (me.isLoading) body = <LoadingState label="Loading AutoApply…" />
        else if (me.isError) body = <ErrorState err={me.error} onRetry={() => me.refetch()} title="Could not load AutoApply" />
        else if (!eligible) body = <UpgradeCard plan={me.data?.plan} />
    }
    return (
        <>
            <Navbar />
            <main className="wrap aa-wrap">
                {showNav && <SubNav showBadge={eligible} />}
                {body}
            </main>
        </>
    )
}

export function UpgradeCard({ plan }) {
    return (
        <section className="aa-card is-warm" aria-labelledby="aa-upgrade-h">
            <h2 id="aa-upgrade-h" style={{ margin: 0, fontSize: '1rem', fontWeight: 900, color: 'var(--bright)' }}>
                AutoApply needs Pro or Max
            </h2>
            <p className="aa-muted" style={{ margin: '8px 0 14px' }}>
                {plan && plan !== 'free' ? `Your current plan (${plan}) doesn't include AutoApply. ` : "You're on the Free plan. "}
                Upgrade to Pro or Max to buy AutoApply packs. Credits are only used when an application is actually submitted.
            </p>
            <Link to="/pricing" className="aa-btn is-primary">See Pro and Max</Link>
        </section>
    )
}

export function PageHeader({ eyebrow, title, lead, actions }) {
    return (
        <header className="aa-spread" style={{ alignItems: 'flex-end', marginBottom: 20 }}>
            <div>
                {eyebrow && <span className="aa-eyebrow">{eyebrow}</span>}
                <h1 className="aa-h1">{title}</h1>
                {lead && <p className="aa-lead">{lead}</p>}
            </div>
            {actions && <div className="aa-row">{actions}</div>}
        </header>
    )
}

import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Check, Copy } from 'lucide-react'
import Navbar from '../../components/Navbar'
import { ErrorState, LoadingState } from '../../components/shared/states'
import { useAutoApplyMe, useInboxUnread, useNeedsYou } from '../../lib/useAutoApply'
import './autoapply.css'

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
// Service prices are fixed by the product brief; product prices ONLY come from
// the API (GET /me -> config.packs.product). Never hard-code product prices.
const SERVICE_FALLBACK = { 50: 59900, 100: 115000 }

export function packPrice(config, kind, size) {
    const fromApi = config?.packs?.[kind]?.[size] ?? config?.packs?.[kind]?.[String(size)]
    if (fromApi != null) return Number(fromApi)
    if (kind === 'service') return SERVICE_FALLBACK[size]
    return null
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
    return key ? `/autoapply/setup?step=${setupStepFor(key)}` : '/autoapply/setup'
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
    const [done, setDone] = useState(false)
    useEffect(() => {
        if (!done) return undefined
        const t = setTimeout(() => setDone(false), 1600)
        return () => clearTimeout(t)
    }, [done])
    async function copy() {
        try {
            await navigator.clipboard.writeText(text || '')
            setDone(true)
        } catch {
            setDone(false)
        }
    }
    return (
        <button type="button" className={className} onClick={copy} disabled={!text} aria-label={`${label}${done ? ' (copied)' : ''}`}>
            {done ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
            {done ? 'Copied' : label}
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
    { to: '/autoapply', label: 'Overview', exact: true },
    { to: '/autoapply/batches', label: 'Batches' },
    { to: '/autoapply/needs-you', label: 'Needs you', badge: true },
    { to: '/autoapply/buy', label: 'Buy' },
    { to: '/autoapply/inbox', label: 'Inbox', unread: true },
    { to: '/autoapply/interviews', label: 'Interviews' },
    { to: '/autoapply/accounts', label: 'Accounts' },
    { to: '/autoapply/setup', label: 'Setup' },
]

function SubNav({ showBadge }) {
    const { pathname } = useLocation()
    const needs = useNeedsYou()
    const unread = useInboxUnread({ enabled: !!showBadge })
    const count = showBadge ? (needs.data?.items?.length || 0) : 0
    const unreadCount = showBadge ? (unread.data?.count || 0) : 0
    return (
        <nav className="aa-subnav" aria-label="AutoApply">
            {TABS.map((t) => {
                const active = t.exact ? pathname === t.to : pathname.startsWith(t.to)
                return (
                    <Link key={t.to} to={t.to} className={`nav-pill${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}>
                        {t.label}
                        {t.badge && count > 0 && <span className="aa-count" aria-label={`${count} waiting`}>{count}</span>}
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

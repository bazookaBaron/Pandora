import { useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff, KeyRound, Search } from 'lucide-react'
import { Row, Sheet } from '../../components/ui'
import { EmptyState, ErrorState, LoadingState, errorText } from '../../components/shared/states'
import { useAccounts, useRevealPassword } from '../../lib/useAutoApply'
import { CopyButton, EmptyArt, fmtDate } from './ui'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'

const STATUS = {
    active: ['Active', 't-green'],
    pending_verify: ['Awaiting verification', 't-amber'],
    locked: ['Locked', 't-red'],
    user_supplied: ['Your own login', 't-pop'],
}

// Reveal needs a recent sign-in (server answers 401 reauth_required). Email
// users confirm their password inline; OAuth users go through the provider
// again and come back here, where the reveal they asked for resumes.
const REVEAL_AFTER_AUTH = 'aa:reveal-after-auth'

function ReauthPrompt({ host, onDone, onCancel }) {
    const { user } = useAuth()
    const provider = user?.app_metadata?.provider || 'email'
    const [password, setPassword] = useState('')
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState('')

    async function confirmPassword(e) {
        e.preventDefault()
        if (!password || busy) return
        setBusy(true)
        setErr('')
        try {
            const { error } = await supabase.auth.signInWithPassword({ email: user.email, password })
            if (error) throw error
            setPassword('')
            onDone()
        } catch (e2) {
            setErr(errorText(e2, 'Sign-in failed. Check your password.'))
        } finally {
            setBusy(false)
        }
    }

    async function viaProvider() {
        setBusy(true)
        setErr('')
        try { sessionStorage.setItem(REVEAL_AFTER_AUTH, host) } catch { /* private mode */ }
        const { error } = await supabase.auth.signInWithOAuth({
            provider,
            options: { redirectTo: `${window.location.origin}/autoapply/account?section=sites` },
        })
        if (error) {
            setBusy(false)
            setErr(errorText(error))
        }
    }

    return (
        <div className="aa-note is-warn aa-stack" role="alert" style={{ gap: 8 }}>
            <span>For your security, sign in again to reveal saved passwords.</span>
            {provider === 'email' ? (
                <form className="aa-row" style={{ gap: 6 }} onSubmit={confirmPassword}>
                    <label className="aa-sr" htmlFor={`reauth-${host}`}>Your Vloombox password</label>
                    <input id={`reauth-${host}`} type="password" className="input-field" autoComplete="current-password"
                        value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your Vloombox password" style={{ width: 'auto', flex: '1 1 180px' }} />
                    <button type="submit" className="aa-btn is-primary" disabled={busy || !password}>{busy ? 'Checking…' : 'Confirm and reveal'}</button>
                    <button type="button" className="aa-btn" onClick={onCancel} disabled={busy}>Cancel</button>
                </form>
            ) : (
                <div className="aa-row" style={{ gap: 6 }}>
                    <button type="button" className="aa-btn is-primary" onClick={viaProvider} disabled={busy}>
                        {busy ? 'Redirecting…' : `Sign in again with ${provider.charAt(0).toUpperCase()}${provider.slice(1)}`}
                    </button>
                    <button type="button" className="aa-btn" onClick={onCancel} disabled={busy}>Cancel</button>
                </div>
            )}
            {err && <span style={{ color: 'var(--red)' }}>{err}</span>}
        </div>
    )
}

// Password is fetched on demand, shown once, and dropped from memory on hide.
function Reveal({ host }) {
    const reveal = useRevealPassword()
    const [pw, setPw] = useState(null)
    const [err, setErr] = useState(null)

    function doReveal() {
        setErr(null)
        reveal.mutate(host, {
            onSuccess: (r) => setPw(r?.password || ''),
            onError: (e) => setErr(e),
        })
    }

    // Back from an OAuth re-sign-in started for this host: resume the reveal.
    useEffect(() => {
        let pendingHost = null
        try { pendingHost = sessionStorage.getItem(REVEAL_AFTER_AUTH) } catch { /* private mode */ }
        if (pendingHost !== host) return
        try { sessionStorage.removeItem(REVEAL_AFTER_AUTH) } catch { /* private mode */ }
        doReveal()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [host])

    if (pw) {
        return (
            <div className="aa-row" style={{ gap: 6 }}>
                <code className="aa-code" style={{ width: 'auto', padding: '4px 8px' }} aria-label={`Password for ${host}`}>{pw}</code>
                <CopyButton text={pw} label="Copy" />
                <button type="button" className="aa-btn" onClick={() => { setPw(null); reveal.reset() }} aria-label={`Hide password for ${host}`}>
                    <EyeOff size={12} aria-hidden /> Hide
                </button>
            </div>
        )
    }
    return (
        <div className="aa-stack" style={{ gap: 6 }}>
            <button type="button" className="aa-btn" disabled={reveal.isPending} aria-label={`Reveal password for ${host}`}
                onClick={doReveal}>
                <Eye size={12} aria-hidden /> {reveal.isPending ? 'Revealing…' : 'Reveal password'}
            </button>
            {err?.code === 'reauth_required' ? (
                <ReauthPrompt host={host} onDone={doReveal} onCancel={() => setErr(null)} />
            ) : err && <span className="aa-faint" style={{ color: 'var(--red)' }} role="alert">{errorText(err)}</span>}
        </div>
    )
}

// 'boards.greenhouse.io/acme' / 'acme.wd3.myworkdayjobs.com' -> 'acme': the company part of a career-site host
const NOISE = new Set(['www', 'jobs', 'careers', 'career', 'apply', 'boards', 'job-boards', 'eu', 'us', 'com', 'co', 'in', 'io', 'net', 'org',
    'greenhouse', 'lever', 'myworkdayjobs', 'workday', 'smartrecruiters', 'ashbyhq', 'icims', 'taleo', 'successfactors', 'oraclecloud'])
function companyOf(host) {
    const parts = String(host || '').toLowerCase().split(/[./]/).filter((p) => p && !NOISE.has(p) && !/^wd\d+$/.test(p))
    return parts[0] || String(host || '')
}

function pendingRevealHost() {
    try { return sessionStorage.getItem(REVEAL_AFTER_AUTH) } catch { return null }
}

// Search + one line per site; tapping a row opens a sheet with the login and the password reveal.
export default function SitesSection() {
    const q = useAccounts()
    const [term, setTerm] = useState('')
    // back from an OAuth re-sign-in: reopen that site's sheet so its Reveal resumes
    const [openHost, setOpenHost] = useState(pendingRevealHost)
    const accounts = useMemo(() => q.data?.accounts || [], [q.data?.accounts])
    const needle = term.trim().toLowerCase().slice(0, 80)
    const shown = useMemo(() => (needle
        ? accounts.filter((a) => [a.tenant_host, companyOf(a.tenant_host), a.login_email].some((v) => String(v || '').toLowerCase().includes(needle)))
        : accounts), [accounts, needle])
    const open = accounts.find((a) => a.tenant_host === openHost) || null

    if (q.isLoading) return <LoadingState label="Loading logins…" />
    if (q.isError) return <ErrorState err={q.error} onRetry={() => q.refetch()} title="Could not load logins" />
    if (accounts.length === 0) {
        return <EmptyState icon={<EmptyArt kind="accounts" tone="active" />} title="No logins yet" message="Sites where we make a login for you show up here." />
    }
    return (
        <section aria-label="Job portal logins">
            <div className="aa-acct-search" role="search">
                <label htmlFor="acct-q" className="aa-sr">Search by company or site</label>
                <Search size={16} aria-hidden="true" className="aa-acct-search-icon" />
                <input id="acct-q" type="search" className="input-field" value={term} maxLength={80}
                    onChange={(e) => setTerm(e.target.value)} placeholder="Search a company" autoComplete="off" />
            </div>
            <p className="aa-faint" role="status" aria-live="polite" style={{ margin: '0 0 8px' }}>
                {needle ? `${shown.length} of ${accounts.length} match` : `${accounts.length} login${accounts.length === 1 ? '' : 's'} · passwords are encrypted`}
            </p>
            {shown.length === 0 ? (
                <EmptyState compact icon={<EmptyArt kind="search" tone="history" />} title="No login for that company"
                    action={<button type="button" className="aa-btn" onClick={() => setTerm('')}>Clear search</button>} />
            ) : (
                <ul className="sys-rows">
                    {shown.map((a) => {
                        const [label] = STATUS[a.status] || [a.status]
                        const metaTone = a.status === 'active' ? 'success' : a.status === 'locked' ? 'danger' : a.status === 'pending_verify' ? 'waiting' : 'active'
                        return (
                            <li key={a.tenant_host}>
                                <Row leading={<KeyRound size={18} />} title={<span style={{ textTransform: 'capitalize' }}>{companyOf(a.tenant_host)}</span>}
                                    meta={label} metaTone={metaTone} onClick={() => setOpenHost(a.tenant_host)} aria-label={`${companyOf(a.tenant_host)}, ${label}`} />
                            </li>
                        )
                    })}
                </ul>
            )}
            <Sheet open={!!open} onClose={() => setOpenHost(null)} title={open ? companyOf(open.tenant_host) : 'Login'} description={open?.tenant_host}>
                {open && (
                    <div className="aa-stack" style={{ gap: 14 }}>
                        <dl className="aa-dl">
                            <div><dt>Login</dt><dd style={{ overflowWrap: 'anywhere' }}>{open.login_email}</dd></div>
                            <div><dt>Status</dt><dd>{(STATUS[open.status] || [open.status])[0]}</dd></div>
                            <div><dt>{open.last_used_at ? 'Last used' : 'Made'}</dt><dd>{open.last_used_at ? fmtDate(open.last_used_at) : fmtDate(open.created_at, false)}</dd></div>
                        </dl>
                        <div className="aa-row" style={{ gap: 8 }}>
                            <CopyButton text={open.login_email} label="Copy login" className="aa-btn aa-sheet-btn" />
                        </div>
                        <Reveal host={open.tenant_host} />
                        <p className="aa-faint" style={{ margin: 0 }}>Each reveal is logged.</p>
                    </div>
                )}
            </Sheet>
        </section>
    )
}


import { useEffect, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { EmptyState, ErrorState, LoadingState, errorText } from '../../components/shared/states'
import { useAccounts, useRevealPassword } from '../../lib/useAutoApply'
import { CopyButton, fmtDate } from './ui'
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

export default function SitesSection() {
    const q = useAccounts()
    const accounts = q.data?.accounts || []

    return (
        <div>
            <p className="aa-muted" style={{ margin: '0 0 12px' }}>Accounts we created for you on company career sites. Passwords are encrypted; each reveal is logged.</p>
            {q.isLoading ? (
                <LoadingState label="Loading accounts…" />
            ) : q.isError ? (
                <ErrorState err={q.error} onRetry={() => q.refetch()} title="Could not load accounts" />
            ) : accounts.length === 0 ? (
                <EmptyState icon="🔐" title="No accounts yet" message="When a site needs an account to apply, we create one with your apply address and list it here." />
            ) : (
                <div className="aa-table-wrap">
                    <table className="aa-table">
                        <caption className="aa-sr">Career-site accounts</caption>
                        <thead><tr><th scope="col">Site</th><th scope="col">Login</th><th scope="col">Status</th><th scope="col">Last used</th><th scope="col">Password</th></tr></thead>
                        <tbody>
                            {accounts.map((a) => {
                                const [label, tone] = STATUS[a.status] || [a.status, 't-muted']
                                return (
                                    <tr key={a.tenant_host}>
                                        <td className="aa-strong" data-label="Site" style={{ overflowWrap: 'anywhere' }}>{a.tenant_host}</td>
                                        <td data-label="Login" style={{ overflowWrap: 'anywhere' }}>{a.login_email}</td>
                                        <td data-label="Status"><span className={`aa-pill ${tone}`}>{label}</span></td>
                                        <td data-label="Last used">{a.last_used_at ? fmtDate(a.last_used_at) : `Created ${fmtDate(a.created_at, false)}`}</td>
                                        <td data-label="Password"><Reveal host={a.tenant_host} /></td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    )
}

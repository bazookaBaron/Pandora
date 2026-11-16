import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { EmptyState, ErrorState, LoadingState, errorText } from '../../components/shared/states'
import { useAccounts, useRevealPassword } from '../../lib/useAutoApply'
import { AALayout, CopyButton, PageHeader, fmtDate } from './ui'

const STATUS = {
    active: ['Active', 't-green'],
    pending_verify: ['Awaiting verification', 't-amber'],
    locked: ['Locked', 't-red'],
    user_supplied: ['Your own login', 't-pop'],
}

// Password is fetched on demand, shown once, and dropped from memory on hide.
function Reveal({ host }) {
    const reveal = useRevealPassword()
    const [pw, setPw] = useState(null)
    const [err, setErr] = useState(null)

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
                onClick={() => {
                    setErr(null)
                    reveal.mutate(host, {
                        onSuccess: (r) => setPw(r?.password || ''),
                        onError: (e) => setErr(e),
                    })
                }}>
                <Eye size={12} aria-hidden /> {reveal.isPending ? 'Revealing…' : 'Reveal password'}
            </button>
            {err && <span className="aa-faint" style={{ color: 'var(--red)' }} role="alert">{errorText(err)}</span>}
        </div>
    )
}

export default function AccountsPage() {
    const q = useAccounts()
    const accounts = q.data?.accounts || []

    return (
        <AALayout gate>
            <PageHeader eyebrow="Accounts" title="Career-site accounts" lead="Accounts we created for you on company career sites. Passwords are encrypted; each reveal is logged." />
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
        </AALayout>
    )
}

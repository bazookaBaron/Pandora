import { EmptyState, ErrorState, LoadingState } from '../../components/shared/states'
import { useAutoApplyMe, useInbox } from '../../lib/useAutoApply'
import { AALayout, CopyButton, PageHeader, fmtAgo, fmtDate } from './ui'

export default function InboxPage() {
    const me = useAutoApplyMe()
    const q = useInbox(50)
    const mails = q.data?.mails || []
    const address = me.data?.email?.address

    return (
        <AALayout gate>
            <PageHeader
                eyebrow="Inbox"
                title="Apply inbox"
                lead="Mail that job sites sent to your apply address. We read verification codes automatically."
                actions={address ? <CopyButton text={address} label="Copy address" /> : null}
            />
            {address && <p className="aa-faint" style={{ margin: '-8px 0 16px' }}>{address}</p>}
            {q.isLoading ? (
                <LoadingState label="Loading mail…" />
            ) : q.isError ? (
                <ErrorState err={q.error} onRetry={() => q.refetch()} title="Could not load mail" />
            ) : mails.length === 0 ? (
                <EmptyState icon="✉️" title="No mail yet" message="Verification mails and recruiter replies to your apply address show up here." />
            ) : (
                <ul className="aa-list">
                    {mails.map((m) => (
                        <li key={m.id} className={`aa-card${m.is_human ? ' is-warm' : ''}`}>
                            <div className="aa-spread">
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ color: 'var(--bright)', fontWeight: 800, fontSize: '0.84rem', overflowWrap: 'anywhere' }}>{m.subject || '(no subject)'}</div>
                                    <div className="aa-faint" style={{ overflowWrap: 'anywhere' }}>{m.sender} · <time dateTime={m.received_at} title={fmtDate(m.received_at)}>{fmtAgo(m.received_at)}</time></div>
                                </div>
                                {m.is_human && <span className="aa-pill t-warm">From a person · forwarded</span>}
                            </div>
                            {m.codes?.length > 0 && (
                                <div className="aa-row" style={{ marginTop: 10 }}>
                                    {m.codes.map((c) => (
                                        <span key={c} className="aa-row" style={{ gap: 6 }}>
                                            <span className="aa-otp" aria-label={`Code ${c}`}>{c}</span>
                                            <CopyButton text={c} label="Copy" />
                                        </span>
                                    ))}
                                </div>
                            )}
                            {m.text_excerpt && (
                                <details style={{ marginTop: 10 }}>
                                    <summary className="aa-faint" style={{ cursor: 'pointer' }}>Show text</summary>
                                    <p className="aa-muted" style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0', overflowWrap: 'anywhere' }}>{m.text_excerpt}</p>
                                </details>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </AALayout>
    )
}

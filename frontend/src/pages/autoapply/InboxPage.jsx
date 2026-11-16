import { useEffect, useState } from 'react'
import { EmptyState, ErrorState, LoadingState } from '../../components/shared/states'
import { useAutoApplyMe, useInbox, useInboxMail } from '../../lib/useAutoApply'
import { AALayout, CopyButton, PageHeader, fmtAgo, fmtDate } from './ui'
import NotifyButton from './NotifyButton'

const TABS = [
    { id: 'important', label: 'Important' },
    { id: 'all', label: 'All' },
    { id: 'codes', label: 'Codes' },
]

const CATEGORY_LABEL = { important: 'Important', code: 'Code', received: 'Receipt', other: 'Other' }

function linkLabel(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '')
    } catch {
        return 'Open link'
    }
}

function safeHref(url) {
    try {
        const u = new URL(url)
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
    } catch {
        return null
    }
}

function MailDetail({ id, onBack }) {
    const q = useInboxMail(id)
    const m = q.data?.mail
    return (
        <section className="aa-card aa-stack" aria-label="Message">
            <div className="aa-row">
                <button type="button" className="aa-btn" onClick={onBack}>← Back to inbox</button>
            </div>
            {q.isLoading ? (
                <LoadingState label="Loading message…" />
            ) : q.isError ? (
                <ErrorState err={q.error} onRetry={() => q.refetch()} title="Could not load this message" />
            ) : (
                <>
                    <h2 className="aa-h2" style={{ overflowWrap: 'anywhere' }}>{m.subject || '(no subject)'}</h2>
                    <div className="aa-stack" style={{ gap: 4 }}>
                        <div className="aa-muted" style={{ overflowWrap: 'anywhere' }}><strong>From:</strong> {m.sender}</div>
                        <div className="aa-muted"><strong>Received:</strong> <time dateTime={m.received_at}>{fmtDate(m.received_at)}</time></div>
                    </div>
                    {m.codes?.length > 0 && (
                        <div className="aa-row">
                            {m.codes.map((c) => (
                                <span key={c} className="aa-row" style={{ gap: 6 }}>
                                    <span className="aa-otp" aria-label={`Code ${c}`}>{c}</span>
                                    <CopyButton text={c} label="Copy" />
                                </span>
                            ))}
                        </div>
                    )}
                    {m.has_attachments && (
                        <p className="aa-note" role="note" style={{ margin: 0 }}>
                            This message had an attachment. We do not keep attachments: ask the sender to resend it to your own email address.
                        </p>
                    )}
                    {m.text_excerpt
                        ? <p className="aa-muted" style={{ whiteSpace: 'pre-wrap', margin: 0, overflowWrap: 'anywhere' }}>{m.text_excerpt}</p>
                        : <p className="aa-faint" style={{ margin: 0 }}>No text in this message.</p>}
                    {m.links?.length > 0 && (
                        <div className="aa-stack" style={{ gap: 8 }}>
                            <span className="field-label">Links in this message</span>
                            <div className="aa-row">
                                {m.links.map((l) => {
                                    const href = safeHref(l)
                                    return href ? (
                                        <a key={l} className="aa-btn" href={href} target="_blank" rel="noopener noreferrer nofollow" title={href}>
                                            {linkLabel(l)} ↗
                                        </a>
                                    ) : null
                                })}
                            </div>
                        </div>
                    )}
                </>
            )}
        </section>
    )
}

export default function InboxPage() {
    const me = useAutoApplyMe()
    const [tab, setTab] = useState('important')
    const [text, setText] = useState('')
    const [term, setTerm] = useState('')
    const [openId, setOpenId] = useState(null)
    const q = useInbox({ tab, q: term })
    const mails = (q.data?.pages || []).flatMap((p) => p.mails || [])
    const address = me.data?.email?.address

    useEffect(() => {
        const t = setTimeout(() => setTerm(text.trim()), 300)
        return () => clearTimeout(t)
    }, [text])

    return (
        <AALayout gate>
            <PageHeader
                eyebrow="Inbox"
                title="Vloombox inbox"
                lead="Everything companies send to your Vloombox address lives here. We never forward your mail; we alert you when an assessment or interview arrives."
                actions={address ? <CopyButton text={address} label="Copy address" /> : null}
            />
            {address && <p className="aa-faint" style={{ margin: '-8px 0 12px', overflowWrap: 'anywhere' }}>{address}</p>}
            <div style={{ marginBottom: 14 }}><NotifyButton /></div>

            {openId ? (
                <MailDetail id={openId} onBack={() => setOpenId(null)} />
            ) : (
                <>
                    <div className="aa-inbox-bar">
                        <div className="aa-tabs" role="tablist" aria-label="Inbox view">
                            {TABS.map((t) => (
                                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`aa-tab${tab === t.id ? ' is-on' : ''}`} onClick={() => setTab(t.id)}>
                                    {t.label}
                                </button>
                            ))}
                        </div>
                        <input
                            type="search"
                            className="input-field aa-inbox-search"
                            placeholder="Search sender, subject, text"
                            aria-label="Search mail"
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                        />
                    </div>

                    {q.isLoading ? (
                        <LoadingState label="Loading mail…" />
                    ) : q.isError ? (
                        <ErrorState err={q.error} onRetry={() => q.refetch()} title="Could not load mail" />
                    ) : mails.length === 0 ? (
                        <EmptyState
                            icon="✉️"
                            title={term ? 'No matches' : tab === 'important' ? 'No important mail yet' : 'No mail yet'}
                            message={term ? 'Try a different search.' : 'Assessments, interview invites and recruiter messages show up here. Verification codes are under Codes.'}
                        />
                    ) : (
                        <>
                            <ul className="aa-list">
                                {mails.map((m) => (
                                    <li key={m.id}>
                                        <button type="button" className={`aa-card aa-mail-row${m.category === 'important' ? ' is-warm' : ''}`} onClick={() => setOpenId(m.id)}>
                                            <span className="aa-spread" style={{ gap: 10 }}>
                                                <span style={{ minWidth: 0, textAlign: 'left' }}>
                                                    <span className="aa-mail-subject">{m.subject || '(no subject)'}</span>
                                                    <span className="aa-faint aa-mail-meta">{m.sender} · <time dateTime={m.received_at} title={fmtDate(m.received_at)}>{fmtAgo(m.received_at)}</time></span>
                                                </span>
                                                <span className="aa-row" style={{ gap: 6, flexShrink: 0 }}>
                                                    {m.has_attachments && <span className="aa-pill" title="Had an attachment">📎</span>}
                                                    {tab === 'all' && <span className={`aa-pill${m.category === 'important' ? ' t-warm' : ''}`}>{CATEGORY_LABEL[m.category] || 'Other'}</span>}
                                                </span>
                                            </span>
                                            {m.codes?.length > 0 && (
                                                <span className="aa-row" style={{ marginTop: 8 }}>
                                                    {m.codes.slice(0, 3).map((c) => <span key={c} className="aa-otp" aria-label={`Code ${c}`}>{c}</span>)}
                                                </span>
                                            )}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                            {q.hasNextPage && (
                                <div className="aa-row" style={{ justifyContent: 'center', marginTop: 14 }}>
                                    <button type="button" className="aa-btn" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                                        {q.isFetchingNextPage ? 'Loading…' : 'Load older mail'}
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                </>
            )}
        </AALayout>
    )
}

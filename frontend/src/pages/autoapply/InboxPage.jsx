import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../../components/shared/states'
import { GuideNextCta } from '../../components/onboarding/AAProgressGuide'
import { useAutoApplyMe, useInbox, useInboxCompanies, useInboxMail, useInboxUnread, useMarkAllRead } from '../../lib/useAutoApply'
import { AALayout, CopyButton, PageHeader, fmtAgo, fmtDate } from './ui'
import NotifyButton from './NotifyButton'
import InterviewCard, { safeHref } from './InterviewCard'
import InterviewsPanel from './InterviewsPanel'

// Views of "All emails": each maps to API filters.
const VIEWS = [
    { id: 'all', label: 'All', f: { tab: 'all' } },
    { id: 'interview', label: 'Interview', f: { kind: 'interview' } },
    { id: 'assessment', label: 'Assessment', f: { kind: 'assessment' } },
    { id: 'offer', label: 'Offer', f: { kind: 'offer' } },
    { id: 'rejected', label: 'Rejected', f: { category: 'rejected' } },
    { id: 'received', label: 'Applied', f: { category: 'received' } },
    { id: 'other', label: 'Other', f: { category: 'other' } },
]
const VIEW_IDS = new Set(VIEWS.map((v) => v.id))
// URL filter is ?f=<id>; legacy links used ?view=<id> and the retired Important / Codes chips.
const LEGACY_VIEWS = { important: { tab: 'important' }, codes: { tab: 'codes' } }

const CATEGORY_LABEL = { important: 'Important', code: 'Code', received: 'Applied', rejected: 'Rejected', other: 'Other' }
const KIND_LABEL = { interview: 'Interview', assessment: 'Assessment', offer: 'Offer', recruiter: 'Recruiter', rejection: 'Rejected' }
const NOTIFY = new Set(['important', 'rejected'])

function label(m) {
    return KIND_LABEL[m.kind] || CATEGORY_LABEL[m.category] || 'Other'
}

function tone(m) {
    if (m.kind === 'offer' || m.kind === 'interview') return ' t-green'
    if (m.kind === 'assessment' || m.category === 'important') return ' t-warm'
    if (m.category === 'rejected') return ' t-red'
    return ' t-muted'
}

function linkLabel(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '')
    } catch {
        return 'Open link'
    }
}

const isUnread = (m) => NOTIFY.has(m.category) && !m.read_at

function MailDetail({ id, onBack }) {
    const q = useInboxMail(id)
    const m = q.data?.mail
    const iv = q.data?.interview
    return (
        <section className="aa-card aa-stack" aria-label="Message">
            <div className="aa-row">
                <button type="button" className="aa-btn" onClick={onBack}>← Back to all emails</button>
            </div>
            {q.isLoading ? (
                <LoadingState label="Loading message…" />
            ) : q.isError ? (
                <ErrorState err={q.error} onRetry={() => q.refetch()} title="Could not load this message" />
            ) : (
                <>
                    <div className="aa-row" style={{ gap: 6 }}>
                        <span className={`aa-pill${tone(m)}`}>{label(m)}</span>
                        {m.company && <span className="aa-pill t-muted">{m.company}</span>}
                    </div>
                    <h2 className="aa-h2" style={{ overflowWrap: 'anywhere' }}>{m.subject || '(no subject)'}</h2>
                    <div className="aa-stack" style={{ gap: 4 }}>
                        <div className="aa-muted" style={{ overflowWrap: 'anywhere' }}><strong>From:</strong> {m.from_name ? `${m.from_name} <${m.sender}>` : m.sender}</div>
                        <div className="aa-muted"><strong>Received:</strong> <time dateTime={m.received_at}>{fmtDate(m.received_at)}</time></div>
                        {m.expires_at && (
                            <div className="aa-faint">Deleted automatically on {fmtDate(m.expires_at, false)} (application receipts and rejections are kept 30 days).</div>
                        )}
                    </div>
                    {iv && <InterviewCard iv={iv} showMailLink={false} past={!!iv.starts_at && new Date(iv.starts_at).getTime() < Date.now()} />}
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
    const [params, setParams] = useSearchParams()
    const rawView = params.get('f') || params.get('view')
    const view = VIEW_IDS.has(rawView) || LEGACY_VIEWS[rawView] ? rawView : 'all'
    const openId = /^\d{1,18}$/.test(params.get('mail') || '') ? params.get('mail') : null
    const [text, setText] = useState('')
    const [term, setTerm] = useState('')
    const [company, setCompany] = useState('')
    const [unreadOnly, setUnreadOnly] = useState(false)
    const filters = (VIEWS.find((v) => v.id === view) || { f: LEGACY_VIEWS[view] }).f
    const q = useInbox({ ...filters, q: term, company, unread: unreadOnly })
    const unread = useInboxUnread()
    const companies = useInboxCompanies()
    const markAll = useMarkAllRead()
    const mails = (q.data?.pages || []).flatMap((p) => p.mails || [])
    const address = me.data?.email?.address
    const unreadCount = unread.data?.count || 0

    useEffect(() => {
        const t = setTimeout(() => setTerm(text.trim()), 300)
        return () => clearTimeout(t)
    }, [text])

    const setParam = (k, v) => {
        const next = new URLSearchParams(params)
        next.delete('view')
        if (v) next.set(k, v)
        else next.delete(k)
        setParams(next, { replace: k === 'f' })
    }

    return (
        <AALayout gate>
            <PageHeader
                eyebrow="Inbox"
                title="Inbox"
                lead="Everything companies send to your Vloombox address. Receipts and rejections are deleted after 30 days."
                actions={address ? <CopyButton text={address} label="Copy address" /> : null}
            />
            {address && <p className="aa-faint" style={{ margin: '-8px 0 12px', overflowWrap: 'anywhere' }}>{address}</p>}
            <div className="aa-row" style={{ marginBottom: 14 }}>
                <NotifyButton />
            </div>

            {openId ? (
                <MailDetail id={openId} onBack={() => setParam('mail', null)} />
            ) : (
                <>
                    <div className="aa-tabs aa-tabs-wrap" role="tablist" aria-label="Filter by category" style={{ marginBottom: 10 }}>
                        {VIEWS.map((v) => (
                            <button key={v.id} type="button" role="tab" aria-selected={view === v.id} className={`aa-tab${view === v.id ? ' is-on' : ''}`} onClick={() => setParam('f', v.id === 'all' ? null : v.id)}>
                                {v.label}
                            </button>
                        ))}
                    </div>
                    {view === 'interview' && <InterviewsPanel />}
                    <div className="aa-inbox-bar">
                        <input
                            type="search"
                            className="input-field aa-inbox-search"
                            placeholder="Search sender, subject, text"
                            aria-label="Search mail"
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                        />
                        <select className="input-field aa-inbox-company" aria-label="Filter by company" value={company} onChange={(e) => setCompany(e.target.value)}>
                            <option value="">All companies</option>
                            {(companies.data?.companies || []).map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <label className="aa-row aa-faint" style={{ gap: 6, cursor: 'pointer' }}>
                            <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
                            Unread only
                        </label>
                        {unreadCount > 0 && (
                            <button type="button" className="aa-btn" onClick={() => markAll.mutate()} disabled={markAll.isPending}>
                                {markAll.isPending ? 'Working…' : `Mark ${unreadCount} as read`}
                            </button>
                        )}
                    </div>

                    {q.isLoading ? (
                        <LoadingState label="Loading mail…" />
                    ) : q.isError ? (
                        <ErrorState err={q.error} onRetry={() => q.refetch()} title="Could not load mail" />
                    ) : mails.length === 0 ? (
                        <EmptyState
                            icon="✉️"
                            title={term || company || unreadOnly ? 'No matches' : 'No mail yet. Replies, assessments and interview invites land here.'}
                            message={term || company || unreadOnly ? 'Try a different search or filter.' : undefined}
                            action={term || company || unreadOnly ? undefined : <GuideNextCta fallback={{ to: '/autoapply', label: 'Open overview' }} />}
                        />
                    ) : (
                        <>
                            <ul className="aa-list">
                                {mails.map((m) => (
                                    <li key={m.id}>
                                        <button
                                            type="button"
                                            className={`aa-card aa-mail-row${m.category === 'important' ? ' is-warm' : ''}${isUnread(m) ? ' is-unread' : ''}`}
                                            onClick={() => setParam('mail', String(m.id))}
                                            aria-label={`${isUnread(m) ? 'Unread: ' : ''}${m.subject || '(no subject)'}`}
                                        >
                                            <span className="aa-spread" style={{ gap: 10 }}>
                                                <span style={{ minWidth: 0, textAlign: 'left' }}>
                                                    <span className="aa-mail-subject">
                                                        {isUnread(m) && <span className="aa-unread-dot" aria-hidden />}
                                                        {m.subject || '(no subject)'}
                                                    </span>
                                                    <span className="aa-faint aa-mail-meta">
                                                        {m.company ? `${m.company} · ` : ''}{m.from_name || m.sender} · <time dateTime={m.received_at} title={fmtDate(m.received_at)}>{fmtAgo(m.received_at)}</time>
                                                    </span>
                                                </span>
                                                <span className="aa-row" style={{ gap: 6, flexShrink: 0 }}>
                                                    {m.has_attachments && <span className="aa-pill" title="Had an attachment">📎</span>}
                                                    <span className={`aa-pill${tone(m)}`}>{label(m)}</span>
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

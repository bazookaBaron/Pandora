import { useEffect, useState } from 'react'
import { Bell, Paperclip, SlidersHorizontal } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../../components/shared/states'
import { GuideNextCta } from '../../components/onboarding/AAProgressGuide'
import { PageHeader, Row, Sheet, SmallTabs } from '../../components/ui'
import { useAutoApplyMe, useInbox, useInboxCompanies, useInboxMail, useInboxUnread, useMarkAllRead } from '../../lib/useAutoApply'
import { AALayout, CopyButton, EmptyArt, fmtAgo, fmtDate } from './ui'
import NotifyButton from './NotifyButton'
import InterviewCard, { safeHref } from './InterviewCard'
import InterviewsPanel from './InterviewsPanel'

// Views of the inbox: each maps to API filters.
const VIEWS = [
    { id: 'all', label: 'All', f: { tab: 'all' } },
    { id: 'interview', label: 'Interview', f: { kind: 'interview' } },
    { id: 'assessment', label: 'Test', f: { kind: 'assessment' } },
    { id: 'offer', label: 'Offer', f: { kind: 'offer' } },
    { id: 'rejected', label: 'Rejected', f: { category: 'rejected' } },
    { id: 'received', label: 'Applied', f: { category: 'received' } },
    { id: 'other', label: 'Other', f: { category: 'other' } },
]
const VIEW_IDS = new Set(VIEWS.map((v) => v.id))
// URL filter is ?f=<id>; legacy links used ?view=<id> and the retired Important / Codes chips.
const LEGACY_VIEWS = { important: { tab: 'important' }, codes: { tab: 'codes' } }

const CATEGORY_LABEL = { important: 'Important', code: 'Code', received: 'Applied', rejected: 'Rejected', other: 'Other' }
const KIND_LABEL = { interview: 'Interview', assessment: 'Test', offer: 'Offer', recruiter: 'Recruiter', rejection: 'Rejected' }
const NOTIFY = new Set(['important', 'rejected'])

function label(m) {
    return KIND_LABEL[m.kind] || CATEGORY_LABEL[m.category] || 'Other'
}

// Interview / Assessment / Offer (and anything flagged urgent) are the mails that need you.
const URGENT_KINDS = new Set(['interview', 'assessment', 'offer'])
const isUrgent = (m) => URGENT_KINDS.has(m.kind) || !!(m.urgent || m.action_needed || m.action_required)

function tone(m) {
    if (isUrgent(m)) return ' t-urgent'
    if (m.category === 'important') return ' t-warm'
    if (m.category === 'code') return ' t-pop'
    if (m.category === 'received') return ' t-green'
    return ' t-muted'
}

function TypePill({ m }) {
    return (
        <span className={`aa-pill${tone(m)}`}>
            {isUrgent(m) && <Bell size={12} aria-hidden />}
            {label(m)}
        </span>
    )
}

function linkLabel(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '')
    } catch {
        return 'Open link'
    }
}

const isUnread = (m) => NOTIFY.has(m.category) && !m.read_at

function MailBody({ id }) {
    const q = useInboxMail(id)
    const m = q.data?.mail
    const iv = q.data?.interview
    if (q.isLoading) return <LoadingState label="Loading message…" />
    if (q.isError) return <ErrorState err={q.error} onRetry={() => q.refetch()} title="Could not load this message" />
    if (!m) return null
    return (
        <div className="aa-stack">
            <div className="aa-row" style={{ gap: 6 }}>
                <TypePill m={m} />
                {m.company && <span className="aa-pill t-muted">{m.company}</span>}
            </div>
            <div className="aa-stack" style={{ gap: 4 }}>
                <div className="aa-muted" style={{ overflowWrap: 'anywhere' }}>From {m.from_name ? `${m.from_name} <${m.sender}>` : m.sender}</div>
                <div className="aa-muted"><time dateTime={m.received_at}>{fmtDate(m.received_at)}</time></div>
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
            {m.has_attachments && <p className="aa-faint" role="note" style={{ margin: 0 }}>Attachment not kept. Ask the sender to resend it to your own email.</p>}
            {m.text_excerpt
                ? <p className="aa-mail-text">{m.text_excerpt}</p>
                : <p className="aa-faint" style={{ margin: 0 }}>No text in this message.</p>}
            {m.links?.length > 0 && (
                <div className="aa-row">
                    {m.links.map((l) => {
                        const href = safeHref(l)
                        return href ? (
                            <a key={l} className="aa-btn aa-sheet-btn" href={href} target="_blank" rel="noopener noreferrer nofollow" title={href}>
                                {linkLabel(l)} ↗
                            </a>
                        ) : null
                    })}
                </div>
            )}
            {m.expires_at && <p className="aa-faint" style={{ margin: 0 }}>Deleted on {fmtDate(m.expires_at, false)}. Receipts and rejections are kept 30 days.</p>}
        </div>
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
    const [filtersOpen, setFiltersOpen] = useState(false)
    const filters = (VIEWS.find((v) => v.id === view) || { f: LEGACY_VIEWS[view] }).f
    const q = useInbox({ ...filters, q: term, company, unread: unreadOnly })
    const unread = useInboxUnread()
    const companies = useInboxCompanies()
    const markAll = useMarkAllRead()
    const mails = (q.data?.pages || []).flatMap((p) => p.mails || [])
    const address = me.data?.email?.address
    const unreadCount = unread.data?.count || 0
    const openMail = openId ? mails.find((m) => String(m.id) === openId) : null
    const filtered = !!(term || company || unreadOnly)
    const extraFilters = (company ? 1 : 0) + (unreadOnly ? 1 : 0)

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
            <PageHeader section="autoapply" title="Inbox" subtitle="Replies from companies land here." back={{ to: '/autoapply', label: 'Auto Apply' }} />

            <SmallTabs idPrefix="inbox" label="Mail type" section="autoapply" value={VIEW_IDS.has(view) ? view : 'all'}
                onChange={(v) => setParam('f', v === 'all' ? null : v)} items={VIEWS.map((v) => ({ value: v.id, label: v.label }))} />

            <div className="aa-inbox-tools">
                <label className="aa-sr" htmlFor="inbox-q">Search mail</label>
                <input id="inbox-q" type="search" className="input-field" placeholder="Search mail" value={text} onChange={(e) => setText(e.target.value)} />
                <button type="button" className="aa-icon-only" onClick={() => setFiltersOpen(true)} aria-label={`Filters and settings${extraFilters ? `, ${extraFilters} on` : ''}`}>
                    <SlidersHorizontal size={20} aria-hidden="true" />
                    {extraFilters > 0 && <span className="aa-dot-badge" aria-hidden="true">{extraFilters}</span>}
                </button>
            </div>

            {view === 'interview' && <InterviewsPanel />}

            {q.isLoading ? (
                <LoadingState label="Loading mail…" />
            ) : q.isError ? (
                <ErrorState err={q.error} onRetry={() => q.refetch()} title="Could not load mail" />
            ) : mails.length === 0 ? (
                <EmptyState
                    icon={<EmptyArt kind={filtered ? 'search' : 'inbox'} tone="active" />}
                    title={filtered ? 'No matches' : 'No mail yet'}
                    message={filtered ? 'Try a different search or filter.' : 'Replies, tests and interview invites land here.'}
                    action={filtered ? undefined : <GuideNextCta fallback={{ to: '/autoapply', label: 'Back to Auto Apply' }} />}
                />
            ) : (
                <>
                    <ul className="sys-rows aa-mails" aria-label="Emails">
                        {mails.map((m) => {
                            const unreadRow = isUnread(m)
                            const from = m.company || m.from_name || m.sender
                            const urgent = isUrgent(m)
                            return (
                                <li key={m.id}>
                                    <Row
                                        className={unreadRow ? 'is-unread' : ''}
                                        leading={<span className={`aa-mdot${unreadRow ? ' is-on' : ''}`} aria-hidden="true" />}
                                        title={<><span className="aa-m-from">{from}</span><span className="aa-m-sep" aria-hidden="true"> · </span>{m.subject || '(no subject)'}</>}
                                        meta={(
                                            <span className="aa-m-meta">
                                                {m.has_attachments && <Paperclip size={12} aria-hidden="true" />}
                                                {urgent && <span className="aa-pill t-urgent">{label(m)}</span>}
                                                <time dateTime={m.received_at}>{fmtAgo(m.received_at)}</time>
                                            </span>
                                        )}
                                        onClick={() => setParam('mail', String(m.id))}
                                        aria-label={`${unreadRow ? 'Unread. ' : ''}${label(m)} from ${from}: ${m.subject || '(no subject)'}, ${fmtAgo(m.received_at)}`}
                                    />
                                </li>
                            )
                        })}
                    </ul>
                    {q.hasNextPage && (
                        <div className="aa-row" style={{ justifyContent: 'center', marginTop: 14 }}>
                            <button type="button" className="aa-btn aa-sheet-btn" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                                {q.isFetchingNextPage ? 'Loading…' : 'Load older mail'}
                            </button>
                        </div>
                    )}
                </>
            )}

            <Sheet open={!!openId} onClose={() => setParam('mail', null)} title={openMail?.subject || 'Message'} size="full">
                {openId && <MailBody id={openId} />}
            </Sheet>

            <Sheet open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters"
                footer={<button type="button" className="sys-tone-btn aa-tone" onClick={() => setFiltersOpen(false)}>Done</button>}>
                <div className="aa-stack" style={{ gap: 16 }}>
                    <div className="aa-field">
                        <label className="field-label" htmlFor="inbox-company">Company</label>
                        <select id="inbox-company" className="input-field provider-select" value={company} onChange={(e) => setCompany(e.target.value)}>
                            <option value="">All companies</option>
                            {(companies.data?.companies || []).map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                    </div>
                    <label className="aa-check">
                        <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
                        <span>Unread only</span>
                    </label>
                    {unreadCount > 0 && (
                        <button type="button" className="aa-btn aa-sheet-btn" onClick={() => markAll.mutate()} disabled={markAll.isPending}>
                            {markAll.isPending ? 'Working…' : `Mark ${unreadCount} as read`}
                        </button>
                    )}
                    {address && (
                        <div className="aa-field">
                            <span className="field-label">Your apply address</span>
                            <div className="aa-row">
                                <code className="aa-code" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{address}</code>
                                <CopyButton text={address} label="Copy" />
                            </div>
                        </div>
                    )}
                    <NotifyButton />
                </div>
            </Sheet>
        </AALayout>
    )
}

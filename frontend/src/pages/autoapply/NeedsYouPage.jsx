import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { EmptyState, ErrorState, LoadingState } from '../../components/shared/states'
import { GuideNextCta } from '../../components/onboarding/AAProgressGuide'
import { useNeedsYou, useResolveNeedsYou } from '../../lib/useAutoApply'
import { Link } from 'react-router-dom'
import { AALayout, InlineConfirm, PageHeader, ProfileMissing, fmtAgo } from './ui'
import { safeHref } from './InterviewCard'

const KIND = {
    profile: { title: 'Complete your profile', help: 'A paid batch is waiting until your profile is complete. We start applying on our next check after you finish it.' },
    captcha: { title: 'Captcha', help: 'The site asked for a captcha we can’t solve. Open the job, apply yourself, then tell us.' },
    sso: { title: 'Social sign-in', help: 'This site only allows Google / LinkedIn sign-in. Open the job, apply yourself, then tell us.' },
    account: { title: 'Account problem', help: 'We could not create or open your account on this site. Open the job and apply yourself.' },
    question: { title: 'Question', help: 'The form asked something we don’t have an answer for. Your answer is saved and reused next time.' },
    other: { title: 'Needs a human', help: 'Something on this site needs you. Open the job and apply yourself.' },
}
const ORDER = ['profile', 'question', 'captcha', 'sso', 'account', 'other']

// useResolveNeedsYou removes the item from the cache at once (the card
// disappears on click), toasts the result, and puts the card back with an
// error toast if the server rejects it.
function ProfileItem({ item }) {
    const resolve = useResolveNeedsYou()
    const p = item.payload || {}
    const [confirmDismiss, setConfirmDismiss] = useState(false)
    const id = `ny-${item.id}`
    const batchId = item.batch_id || p.batch_id
    return (
        <li className="aa-card aa-stack" aria-labelledby={`${id}-h`}>
            <div className="aa-spread">
                <div>
                    <div id={`${id}-h`} style={{ color: 'var(--bright)', fontWeight: 900, fontSize: '0.86rem' }}>Complete your profile</div>
                    <div className="aa-faint">AutoApply profile · {fmtAgo(item.created_at)}</div>
                </div>
                <span className="aa-pill t-warm">Profile</span>
            </div>
            <ProfileMissing missing={p.missing} lead={`${KIND.profile.help} Still missing:`} />
            <div className="aa-row">
                {batchId && <Link className="aa-btn" to={`/autoapply/batches/${batchId}`}>View batch</Link>}
                {!confirmDismiss && <button type="button" className="aa-btn" onClick={() => setConfirmDismiss(true)} disabled={resolve.isPending}>Hide</button>}
            </div>
            {confirmDismiss && (
                <InlineConfirm
                    message="Hide this reminder? The batch still waits until your profile is complete."
                    confirmLabel="Hide"
                    tone="neutral"
                    busy={resolve.isPending}
                    onConfirm={() => resolve.mutate({ id: item.id, action: 'dismiss' }, { onError: () => setConfirmDismiss(false) })}
                    onCancel={() => setConfirmDismiss(false)}
                />
            )}
        </li>
    )
}

function Item({ item }) {
    return item.kind === 'profile' ? <ProfileItem item={item} /> : <TaskItem item={item} />
}

function TaskItem({ item }) {
    const resolve = useResolveNeedsYou()
    const p = item.payload || {}
    const meta = KIND[item.kind] || KIND.other
    const link = safeHref(p.apply_url) || safeHref(item.task?.apply_url)
    const [answer, setAnswer] = useState(p.suggestion ?? '')
    const [confirmDismiss, setConfirmDismiss] = useState(false)
    const id = `ny-${item.id}`
    const options = Array.isArray(p.options) ? p.options : null

    function act(action, extra) {
        if (resolve.isPending) return
        resolve.mutate({ id: item.id, action, ...extra }, { onError: () => setConfirmDismiss(false) })
    }

    return (
        <li className="aa-card aa-stack" aria-labelledby={`${id}-h`}>
            <div className="aa-spread">
                <div>
                    <div id={`${id}-h`} style={{ color: 'var(--bright)', fontWeight: 900, fontSize: '0.86rem' }}>
                        {item.task?.company || 'Unknown company'}{item.task?.title ? ` · ${item.task.title}` : ''}
                    </div>
                    <div className="aa-faint">{meta.title} · {fmtAgo(item.created_at)}</div>
                </div>
                <span className={`aa-pill ${item.kind === 'question' ? 't-pop' : 't-warm'}`}>{meta.title}</span>
            </div>
            <p className="aa-muted" style={{ margin: 0 }}>
                {p.reason === 'verify_submission' ? 'Please check whether this application went through.' : (p.note || meta.help)}
            </p>

            {p.reason === 'verify_submission' ? (
                // We could not tell whether the final submit landed.
                // 'confirm_submitted' records it as applied (one credit);
                // 'not_submitted' retries it while the pack has credits, else skips it (no credit).
                <div className="aa-row">
                    {link && <a className="aa-btn" href={link} target="_blank" rel="noopener noreferrer"><ExternalLink size={12} aria-hidden /> Open job</a>}
                    <button type="button" className="aa-btn is-primary" onClick={() => act('confirm_submitted')} disabled={resolve.isPending}>It was submitted</button>
                    <button type="button" className="aa-btn" onClick={() => act('not_submitted')} disabled={resolve.isPending}>It wasn&rsquo;t</button>
                </div>
            ) : item.kind === 'question' ? (
                <form className="aa-stack" onSubmit={(e) => { e.preventDefault(); if (String(answer).trim()) act('answer', { answer: String(answer).trim() }) }}>
                    <div className="aa-field">
                        <label className="field-label" htmlFor={`${id}-a`} style={{ textTransform: 'none', letterSpacing: 0, fontSize: '0.8rem', color: 'var(--bright)' }}>
                            {p.question || p.label || 'Question'}
                        </label>
                        {options ? (
                            <select id={`${id}-a`} className="input-field provider-select" value={answer} onChange={(e) => setAnswer(e.target.value)}>
                                <option value="">Choose…</option>
                                {options.map((o) => {
                                    const v = typeof o === 'object' ? o.value : o
                                    const l = typeof o === 'object' ? (o.label ?? o.value) : o
                                    return <option key={v} value={v}>{l}</option>
                                })}
                            </select>
                        ) : (
                            <input id={`${id}-a`} className="input-field" value={answer} onChange={(e) => setAnswer(e.target.value)} />
                        )}
                        {p.suggestion && <div className="field-hint">Suggested from your profile: {p.suggestion}</div>}
                    </div>
                    <div className="aa-row">
                        <button type="submit" className="aa-btn is-primary" disabled={resolve.isPending || !String(answer).trim()}>
                            {resolve.isPending ? 'Saving…' : 'Save answer and retry'}
                        </button>
                        {link && <a className="aa-btn" href={link} target="_blank" rel="noopener noreferrer"><ExternalLink size={12} aria-hidden /> Open job</a>}
                        {!confirmDismiss && <button type="button" className="aa-btn" onClick={() => setConfirmDismiss(true)} disabled={resolve.isPending}>Dismiss</button>}
                    </div>
                </form>
            ) : (
                <div className="aa-row">
                    {link ? (
                        <a className="aa-btn is-primary" href={link} target="_blank" rel="noopener noreferrer"><ExternalLink size={12} aria-hidden /> Open job</a>
                    ) : (
                        <span className="aa-faint">No link for this job.</span>
                    )}
                    <button type="button" className="aa-btn" onClick={() => act('done')} disabled={resolve.isPending}>
                        {resolve.isPending ? 'Saving…' : 'I applied myself'}
                    </button>
                    {!confirmDismiss && <button type="button" className="aa-btn" onClick={() => setConfirmDismiss(true)} disabled={resolve.isPending}>Dismiss</button>}
                </div>
            )}

            {confirmDismiss && (
                <InlineConfirm
                    message="Skip this job? No credit is used."
                    confirmLabel="Skip job"
                    busy={resolve.isPending}
                    onConfirm={() => act('dismiss')}
                    onCancel={() => setConfirmDismiss(false)}
                />
            )}
        </li>
    )
}

export default function NeedsYouPage() {
    const q = useNeedsYou()
    const items = q.data?.items || []
    const groups = ORDER.map((k) => [k, items.filter((i) => (KIND[i.kind] ? i.kind : 'other') === k)]).filter(([, l]) => l.length)

    return (
        <AALayout gate>
            <PageHeader eyebrow="Needs you" title="Applications waiting on you" lead="A few sites need a human. Nothing here uses a credit unless we submit the application." />
            {q.isLoading ? (
                <LoadingState label="Loading…" />
            ) : q.isError ? (
                <ErrorState err={q.error} onRetry={() => q.refetch()} title="Could not load" />
            ) : items.length === 0 ? (
                <EmptyState icon="✅" title="Nothing needs you right now. Captchas, sign-ins and questions show up here." action={<GuideNextCta fallback={{ to: '/autoapply', label: 'Open batches' }} />} />
            ) : (
                <div className="aa-stack">
                    {groups.map(([k, list]) => (
                        <section key={k} aria-labelledby={`grp-${k}`}>
                            <h2 id={`grp-${k}`} className="aa-h2">{KIND[k].title} ({list.length})</h2>
                            <ul className="aa-list">{list.map((i) => <Item key={i.id} item={i} />)}</ul>
                        </section>
                    ))}
                </div>
            )}
        </AALayout>
    )
}

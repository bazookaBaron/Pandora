import { memo, useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { CheckCircle2, Clock, Coins, ExternalLink, Hand, ListChecks, Loader, MinusCircle, Star } from 'lucide-react'
import { safeHref } from './InterviewCard'
import { EmptyState, ErrorState, LoadingState, errorText } from '../../components/shared/states'
import { fetchTaskProof, useAutoApplyRealtime, useBatch, useBatchAction, useCompanySuggest, useSetMustCompanies } from '../../lib/useAutoApply'
import {
    AALayout, BatchStatusPill, EmptyArt, InlineConfirm, MustCompaniesInput, PACK_KINDS, PageHeader, ProfileMissing, Progress, SectionHead, TaskStatusPill,
    batchTone, fmtDate, num, rupees,
} from './ui'

// Ticks every second on its own, so only this <strong> re-renders, not the
// whole page (and its task table).
function Countdown({ iso, fallback }) {
    const text = useCountdown(iso)
    return <>{text || fallback}</>
}

function useDebounced(value, ms) {
    const [v, setV] = useState(value)
    useEffect(() => {
        const t = setTimeout(() => setV(value), ms)
        return () => clearTimeout(t)
    }, [value, ms])
    return v
}

function useCountdown(iso) {
    const [now, setNow] = useState(Date.now())
    useEffect(() => {
        if (!iso) return undefined
        const t = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(t)
    }, [iso])
    if (!iso) return null
    const ms = new Date(iso).getTime() - now
    if (Number.isNaN(ms)) return null
    if (ms <= 0) return 'any moment now'
    const h = Math.floor(ms / 3600000)
    const m = Math.floor((ms % 3600000) / 60000)
    const s = Math.floor((ms % 60000) / 1000)
    return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
}

const CONFIRM_COPY = {
    pause: ['Pause this batch? Nothing new is submitted until you resume. Credits are kept.', 'Pause', 'neutral'],
    resume: ['Resume applying for this batch?', 'Resume', 'neutral'],
    approve: ['Start applying now instead of waiting for the review window to end?', 'Approve now', 'neutral'],
}

function Controls({ batch }) {
    // error shows inline under the buttons; success toasts globally
    const action = useBatchAction({ meta: { inlineError: true } })
    const [pending, setPending] = useState(null)
    const [err, setErr] = useState(null)
    const s = batch.status
    const can = {
        approve: s === 'review',
        pause: ['shortlisting', 'review', 'running', 'waiting_supply', 'waiting_profile', 'paid'].includes(s),
        resume: s === 'paused',
        cancel: false, // no-refund policy: a paid batch is paused, never cancelled (admin-only refunds)
    }
    if (!Object.values(can).some(Boolean)) return null

    function run(a) {
        setErr(null)
        action.mutate({ id: batch.id, action: a }, {
            onSuccess: () => setPending(null),
            onError: (e) => { setErr(e); setPending(null) },
        })
    }

    return (
        <div className="aa-stack">
            {pending ? (
                <InlineConfirm
                    message={CONFIRM_COPY[pending][0]}
                    confirmLabel={CONFIRM_COPY[pending][1]}
                    tone={CONFIRM_COPY[pending][2]}
                    busy={action.isPending}
                    onConfirm={() => { if (!action.isPending) run(pending) }}
                    onCancel={() => { if (!action.isPending) setPending(null) }}
                />
            ) : (
                <div className="aa-row">
                    {can.approve && <button type="button" className="aa-btn is-primary" disabled={action.isPending} onClick={() => setPending('approve')}>Approve now</button>}
                    {can.pause && <button type="button" className="aa-btn" disabled={action.isPending} onClick={() => setPending('pause')}>Pause</button>}
                    {can.resume && <button type="button" className="aa-btn is-primary" disabled={action.isPending} onClick={() => setPending('resume')}>Resume</button>}
                    {can.cancel && <button type="button" className="aa-btn is-danger" disabled={action.isPending} onClick={() => setPending('cancel')}>Cancel batch</button>}
                </div>
            )}
            {err && <ErrorState compact message={errorText(err)} />}
        </div>
    )
}

const NOT_CHARGED_LABEL = { failed: 'failed', captcha: 'captcha', blocked: 'blocked / sign-in', other: 'skipped' }

function ChargeSummary({ charge }) {
    if (!charge) return null
    const reasons = Object.entries(charge.by_reason || {}).filter(([, n]) => n > 0)
    return (
        <section className="aa-card aa-seg tone-success" aria-labelledby="charge-h">
            <SectionHead id="charge-h" icon={Coins} tone="success" title="Credits" />
            <div className="aa-grid">
                <div>
                    <div className="aa-stat-value" style={{ color: 'var(--aa-success)' }}>{num(charge.applied)}</div>
                    <div className="aa-stat-label">Applied · 1 credit each</div>
                </div>
                <div>
                    <div className="aa-stat-value">{num(charge.not_charged)}</div>
                    <div className="aa-stat-label">Not charged</div>
                    {reasons.length > 0 && (
                        <div className="aa-faint" style={{ marginTop: 4 }}>{reasons.map(([k, n]) => `${num(n)} ${NOT_CHARGED_LABEL[k] || k}`).join(' · ')}</div>
                    )}
                </div>
                {charge.in_progress > 0 && (
                    <div>
                        <div className="aa-stat-value">{num(charge.in_progress)}</div>
                        <div className="aa-stat-label">In progress</div>
                    </div>
                )}
            </div>
            <p className="aa-muted" style={{ margin: '12px 0 0' }}>
                Credits are only used for jobs we actually applied to. Failed attempts, captchas, blocked sites and skipped jobs cost nothing. We keep applying until every credit in the pack is used.
            </p>
        </section>
    )
}

function ProofButton({ batchId, task }) {
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState(null)
    async function open() {
        setErr(null)
        setBusy(true)
        // open the tab synchronously (popup blockers), then point it at the short-lived signed URL
        const w = window.open('', '_blank')
        try {
            const { url } = await fetchTaskProof(batchId, task.id)
            if (w) { w.opener = null; w.location.href = url } else window.location.assign(url)
        } catch (e) {
            if (w) w.close()
            setErr(errorText(e))
        } finally {
            setBusy(false)
        }
    }
    return (
        <>
            <button type="button" className="aa-btn" onClick={open} disabled={busy} aria-label={`View proof of the ${task.company} application`}>
                {busy ? 'Opening…' : 'View proof'}
            </button>
            {err && <span className="aa-faint" role="alert">{err}</span>}
        </>
    )
}

function MustCompaniesEditor({ batch }) {
    const save = useSetMustCompanies()
    const current = Array.isArray(batch.must_companies) ? batch.must_companies : []
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(current)
    const [query, setQuery] = useState('')
    const suggest = useCompanySuggest(useDebounced(query, 250), batch.pack_kind)
    const editable = ['paid', 'shortlisting', 'review', 'running', 'paused', 'waiting_supply', 'waiting_profile'].includes(batch.status)
    if (!current.length && !editable) return null
    return (
        <section className="aa-card aa-seg tone-active" aria-labelledby="must-h">
            <SectionHead id="must-h" icon={Star} tone="active" title="Must-apply companies" count={current.length || null}
                action={editable && !editing && <button type="button" className="aa-btn" onClick={() => { setDraft(current); setEditing(true) }}>{current.length ? 'Edit' : 'Add'}</button>} />
            {editing ? (
                <div className="aa-stack" style={{ marginTop: 10 }}>
                    <MustCompaniesInput idPrefix="batch-must" value={draft} onChange={setDraft} query={query} onQuery={setQuery} suggestions={suggest.data?.companies || []} disabled={save.isPending} />
                    <div className="aa-row">
                        <button type="button" className="aa-btn is-primary" disabled={save.isPending}
                            onClick={() => { if (!save.isPending) save.mutate({ id: batch.id, companies: draft }, { onSuccess: () => setEditing(false) }) }}>
                            {save.isPending ? 'Saving…' : 'Save'}
                        </button>
                        <button type="button" className="aa-btn" onClick={() => setEditing(false)} disabled={save.isPending}>Cancel</button>
                    </div>
                </div>
            ) : current.length ? (
                <div className="aa-chips" style={{ marginTop: 10 }}>{current.map((c) => <span key={c} className="aa-chip">{c}</span>)}</div>
            ) : (
                <p className="aa-faint" style={{ margin: '8px 0 0' }}>None. Add up to 10 companies we should apply to first.</p>
            )}
        </section>
    )
}

// Only what the user acts on or keeps: applied jobs (with proof / confirmation) and jobs that need them.
// Skipped, removed, cancelled and unmatched jobs are counted ("Not applied") but never listed.
// Memoised: the page re-renders on every realtime/poll update; the table only needs to when its tasks change.
const TaskTable = memo(function TaskTable({ batchId, tasks, attention = false, empty = null }) {
    if (!tasks.length) return empty
    const whenLabel = attention ? 'Since' : 'Submitted'
    return (
        <div className="aa-table-wrap">
            <table className="aa-table">
                <caption className="aa-sr">{attention ? 'Jobs that need you' : 'Applied jobs'}</caption>
                <thead>
                    <tr>
                        <th scope="col">Company</th><th scope="col">Title</th><th scope="col">Status</th>
                        <th scope="col">{whenLabel}</th><th scope="col"><span className="aa-sr">Actions</span></th>
                    </tr>
                </thead>
                <tbody>
                    {tasks.map((t) => (
                        <tr key={t.id}>
                            <td className="aa-strong" data-label="Company">{t.company}</td>
                            <td data-label="Title">{t.title}</td>
                            <td data-label="Status">
                                <TaskStatusPill status={t.status} />
                                {t.status === 'applied' && t.confirmation_text && (
                                    <div className="aa-faint" style={{ marginTop: 4, maxWidth: 320, overflowWrap: 'anywhere' }} title={t.confirmation_text}>
                                        “{t.confirmation_text.length > 140 ? `${t.confirmation_text.slice(0, 140)}…` : t.confirmation_text}”
                                    </div>
                                )}
                                {t.status === 'applied' && t.confirmation_mail && (
                                    <div style={{ marginTop: 4 }}>
                                        <Link to={`/autoapply/inbox?mail=${encodeURIComponent(t.confirmation_mail.id)}`} style={{ color: 'var(--pop)', fontSize: '0.72rem' }}>
                                            Confirmation mail: {t.confirmation_mail.subject || '(no subject)'}
                                        </Link>
                                    </div>
                                )}
                            </td>
                            <td data-label={whenLabel}>{t.submitted_at ? fmtDate(t.submitted_at) : t.updated_at ? fmtDate(t.updated_at) : '—'}</td>
                            <td>
                                <div className="aa-row" style={{ gap: 6 }}>
                                    {t.status === 'applied' && t.has_proof && <ProofButton batchId={batchId} task={t} />}
                                    {t.status === 'needs_you' && <Link to="/autoapply/needs-you" className="aa-btn is-warm"><Hand size={12} aria-hidden="true" /> Answer</Link>}
                                    {safeHref(t.apply_url) && (
                                        <a className="aa-btn" href={safeHref(t.apply_url)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${t.company} job posting`}>
                                            <ExternalLink size={12} aria-hidden /> Job
                                        </a>
                                    )}
                                </div>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
})

const FLOW_STEPS = [
    ['queued', 'Queued', Clock],
    ['applying', 'Applying', Loader],
    ['applied', 'Applied', CheckCircle2],
    ['needs_you', 'Needs you', Hand],
    ['not_applied', 'Not applied', MinusCircle],
]

// Queued -> Applying -> Applied, plus the two side outcomes, and one plain sentence about what happens now.
function LiveFlow({ live }) {
    const b = live.buckets || {}
    const busy = live.phase === 'applying' || live.phase === 'starting'
    return (
        <div style={{ marginTop: 12 }}>
            <ol className="aa-flow" aria-label="Applications by stage">
                {FLOW_STEPS.map(([k, label, Icon]) => (
                    <li key={k} className={`aa-flow-step is-${k}${b[k] ? ' has' : ''}`}>
                        <Icon size={14} aria-hidden="true" />
                        <span className="aa-flow-n">{num(b[k] || 0)}</span>
                        <span className="aa-flow-label">{label}</span>
                    </li>
                ))}
            </ol>
            <p className="aa-flow-msg" role="status" aria-live="polite">
                {busy && <span className="aa-flow-dot" aria-hidden="true" />}
                {live.message}
            </p>
        </div>
    )
}

export default function BatchDetailPage() {
    const { id } = useParams()
    const [params] = useSearchParams()
    const live = useAutoApplyRealtime()
    const q = useBatch(id, { live })
    const batch = q.data?.batch
    const allTasks = q.data?.tasks
    const needTasks = useMemo(() => (allTasks || []).filter((t) => t.status === 'needs_you'), [allTasks])
    const appliedTasks = useMemo(() => (allTasks || []).filter((t) => t.status === 'applied'), [allTasks])
    const notApplied = q.data?.live?.buckets?.not_applied || 0

    return (
        <AALayout gate>
            {q.isLoading ? (
                <LoadingState label="Loading batch…" />
            ) : q.isError ? (
                <ErrorState err={q.error} onRetry={() => q.refetch()} title={q.error?.status === 404 ? 'Batch not found' : 'Could not load batch'} />
            ) : !batch ? (
                <EmptyState title="Batch not found" action={<Link to="/autoapply" className="aa-btn">Overview</Link>} />
            ) : (
                <>
                    <p style={{ margin: '0 0 10px' }}><Link to="/autoapply" style={{ color: 'var(--pop)', fontSize: '0.76rem', textDecoration: 'none' }}>← Overview</Link></p>
                    <PageHeader
                        eyebrow={live ? 'Live' : 'Batch'}
                        title={`${PACK_KINDS[batch.pack_kind]?.name || batch.pack_kind} · ${batch.pack_size}`}
                        lead={[
                            batch.purchased_at && `Bought ${fmtDate(batch.purchased_at, false)}`,
                            batch.price_paise != null && rupees(batch.price_paise),
                            batch.window_days && `jobs from the last ${batch.window_days} days`,
                            batch.expires_at && `credits expire ${fmtDate(batch.expires_at, false)}`,
                        ].filter(Boolean).join(' · ')}
                        actions={<BatchStatusPill status={batch.status} />}
                    />
                    {params.get('new') && (
                        <div className="aa-note is-ok" role="status" style={{ marginBottom: 14 }}>
                            {batch.status === 'waiting_profile' ? 'Payment confirmed. Complete your profile and we start shortlisting jobs.' : 'Payment confirmed. We are shortlisting jobs for you now.'}
                        </div>
                    )}
                    <div className="aa-stack">
                        <section className={`aa-card aa-seg tone-${batchTone(batch.status)}`} aria-labelledby="prog-h">
                            <SectionHead id="prog-h" icon={ListChecks} tone={batchTone(batch.status)} title="Progress" />
                            <Progress used={batch.credits_used} total={batch.credits_total} />
                            {q.data?.live && <LiveFlow live={q.data.live} />}
                            {batch.status === 'refund_due' || batch.status === 'refunding' || batch.status === 'refunded' ? (
                                <p className="aa-muted" style={{ margin: '12px 0 0' }}>
                                    {batch.status === 'refunded'
                                        ? `Refunded ${batch.refund_paise != null ? rupees(batch.refund_paise) : ''} for unused credits.`
                                        : 'A refund for unused credits is being processed.'}
                                </p>
                            ) : null}
                            {batch.status === 'waiting_profile' && (
                                <ProfileMissing
                                    style={{ marginTop: 12 }}
                                    missing={batch.waiting_detail?.missing}
                                    lead="Waiting for your profile. We start this batch as soon as it is complete (no credit is used meanwhile). Still missing:"
                                />
                            )}
                            {batch.status === 'waiting_supply' && (
                                <p className="aa-muted" style={{ margin: '12px 0 0' }}>No more matching jobs right now. We keep checking for new postings.</p>
                            )}
                        </section>

                        {batch.status === 'review' && (
                            <section className="aa-card aa-seg is-tinted tone-waiting" aria-labelledby="rv-h">
                                <SectionHead id="rv-h" icon={Clock} tone="waiting" title="Review window" />
                                <p className="aa-muted" style={{ margin: '0 0 12px' }}>
                                    Your shortlist is ready. We start applying in{' '}
                                    <strong style={{ color: 'var(--bright)' }} aria-live="off"><Countdown iso={batch.review_until} fallback="a few hours" /></strong>
                                    {batch.review_until && <> (at {fmtDate(batch.review_until)})</>}, or approve now. To skip a company, add it to your blocked list in Setup.
                                </p>
                            </section>
                        )}

                        <ChargeSummary charge={q.data?.charge} />

                        <MustCompaniesEditor key={(batch.must_companies || []).join('|')} batch={batch} />

                        <Controls batch={batch} />

                        {needTasks.length > 0 && (
                            <section className="aa-card aa-seg is-tinted tone-attention" aria-labelledby="need-h">
                                <SectionHead id="need-h" icon={Hand} tone="attention" title="Needs you" count={needTasks.length}
                                    sub="These applications wait for your answer. No credit is used meanwhile." />
                                <TaskTable batchId={batch.id} tasks={needTasks} attention />
                            </section>
                        )}

                        <section className="aa-card aa-seg tone-success" aria-labelledby="tasks-h">
                            <SectionHead id="tasks-h" icon={CheckCircle2} tone="success" title="Applied" count={appliedTasks.length}
                                sub={notApplied > 0 ? `${num(notApplied)} not applied (skipped, closed or removed). Those cost nothing.` : undefined} />
                            <TaskTable batchId={batch.id} tasks={appliedTasks}
                                empty={<EmptyState compact icon={<EmptyArt kind="jobs" tone="success" />} title="No applications submitted yet"
                                    message="Applied jobs show up here with proof and the company's confirmation. This page updates on its own." />} />
                        </section>
                    </div>
                </>
            )}
        </AALayout>
    )
}

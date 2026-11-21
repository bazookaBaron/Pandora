import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import { EmptyState, ErrorState, LoadingState, errorText } from '../../components/shared/states'
import { fetchTaskProof, useAutoApplyRealtime, useBatch, useBatchAction, useCompanySuggest, useRemoveTask, useSetMustCompanies } from '../../lib/useAutoApply'
import {
    AALayout, BatchStatusPill, InlineConfirm, MustCompaniesInput, PACK_KINDS, PageHeader, ProfileMissing, Progress, TASK_STATUS_ORDER, TaskStatusPill,
    fmtDate, num, reasonText, rupees, taskStatusLabel,
} from './ui'

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
    cancel: ['Cancel this batch? We stop applying and refund unused credits pro rata. This cannot be undone.', 'Cancel batch', 'danger'],
    approve: ['Start applying now instead of waiting for the review window to end?', 'Approve now', 'neutral'],
}

function Controls({ batch }) {
    const action = useBatchAction()
    const [pending, setPending] = useState(null)
    const [err, setErr] = useState(null)
    const s = batch.status
    const can = {
        approve: s === 'review',
        pause: ['shortlisting', 'review', 'running', 'waiting_supply', 'waiting_profile', 'paid'].includes(s),
        resume: s === 'paused',
        cancel: ['paid', 'shortlisting', 'review', 'running', 'paused', 'waiting_supply', 'waiting_profile'].includes(s),
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
                    onConfirm={() => run(pending)}
                    onCancel={() => setPending(null)}
                />
            ) : (
                <div className="aa-row">
                    {can.approve && <button type="button" className="aa-btn is-primary" onClick={() => setPending('approve')}>Approve now</button>}
                    {can.pause && <button type="button" className="aa-btn" onClick={() => setPending('pause')}>Pause</button>}
                    {can.resume && <button type="button" className="aa-btn is-primary" onClick={() => setPending('resume')}>Resume</button>}
                    {can.cancel && <button type="button" className="aa-btn is-danger" onClick={() => setPending('cancel')}>Cancel batch</button>}
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
        <section className="aa-card" aria-labelledby="charge-h">
            <h2 id="charge-h" className="aa-h2">Credits</h2>
            <div className="aa-grid">
                <div>
                    <div className="aa-stat-value" style={{ color: 'var(--green, inherit)' }}>{num(charge.applied)}</div>
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
                Credits are only used for jobs we actually applied to. Failed attempts, captchas, blocked sites and skipped jobs cost nothing; unused credits are refunded pro rata.
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
    const suggest = useCompanySuggest(query, batch.pack_kind)
    const editable = ['paid', 'shortlisting', 'review', 'running', 'paused', 'waiting_supply', 'waiting_profile'].includes(batch.status)
    if (!current.length && !editable) return null
    return (
        <section className="aa-card" aria-labelledby="must-h">
            <div className="aa-spread">
                <h2 id="must-h" className="aa-h2" style={{ margin: 0 }}>Must-apply companies</h2>
                {editable && !editing && <button type="button" className="aa-btn" onClick={() => { setDraft(current); setEditing(true) }}>{current.length ? 'Edit' : 'Add'}</button>}
            </div>
            {editing ? (
                <div className="aa-stack" style={{ marginTop: 10 }}>
                    <MustCompaniesInput idPrefix="batch-must" value={draft} onChange={setDraft} query={query} onQuery={setQuery} suggestions={suggest.data?.companies || []} disabled={save.isPending} />
                    <div className="aa-row">
                        <button type="button" className="aa-btn is-primary" disabled={save.isPending}
                            onClick={() => save.mutate({ id: batch.id, companies: draft }, { onSuccess: () => setEditing(false) })}>
                            {save.isPending ? 'Saving…' : 'Save'}
                        </button>
                        <button type="button" className="aa-btn" onClick={() => setEditing(false)} disabled={save.isPending}>Cancel</button>
                    </div>
                    {save.isError && <ErrorState compact message={errorText(save.error)} />}
                </div>
            ) : current.length ? (
                <div className="aa-chips" style={{ marginTop: 10 }}>{current.map((c) => <span key={c} className="aa-chip">{c}</span>)}</div>
            ) : (
                <p className="aa-faint" style={{ margin: '8px 0 0' }}>None. Add up to 10 companies we should apply to first.</p>
            )}
        </section>
    )
}

function TaskTable({ batch, tasks }) {
    const remove = useRemoveTask()
    const [filter, setFilter] = useState('all')
    const [removing, setRemoving] = useState(null)
    const [err, setErr] = useState(null)
    const inReview = batch.status === 'review'

    const present = useMemo(() => {
        const set = new Set(tasks.map((t) => t.status))
        return TASK_STATUS_ORDER.filter((s) => set.has(s))
    }, [tasks])
    const rows = filter === 'all' ? tasks : tasks.filter((t) => t.status === filter)

    function doRemove(taskId) {
        setErr(null)
        setRemoving(taskId)
        remove.mutate({ batchId: batch.id, taskId }, {
            onError: (e) => setErr(e),
            onSettled: () => setRemoving(null),
        })
    }

    if (!tasks.length) {
        return <EmptyState compact icon="🔎" title="No jobs shortlisted yet" message="We are finding jobs that match your preferences. This page updates on its own." />
    }

    return (
        <div className="aa-stack">
            <div className="aa-row">
                <label className="field-label" htmlFor="task-filter" style={{ margin: 0 }}>Show</label>
                <select id="task-filter" className="input-field provider-select" style={{ width: 'auto', padding: '6px 36px 6px 10px' }} value={filter} onChange={(e) => setFilter(e.target.value)}>
                    <option value="all">All ({tasks.length})</option>
                    {present.map((s) => <option key={s} value={s}>{taskStatusLabel(s)} ({tasks.filter((t) => t.status === s).length})</option>)}
                </select>
            </div>
            {err && <ErrorState compact message={errorText(err)} />}
            <div className="aa-table-wrap">
                <table className="aa-table">
                    <caption className="aa-sr">Jobs in this batch</caption>
                    <thead>
                        <tr>
                            <th scope="col">Company</th><th scope="col">Title</th><th scope="col">Status</th>
                            <th scope="col">Score</th><th scope="col">Submitted</th><th scope="col"><span className="aa-sr">Actions</span></th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((t) => (
                            <tr key={t.id}>
                                <td className="aa-strong" data-label="Company">{t.company}</td>
                                <td data-label="Title">
                                    {t.title}
                                    {t.ats && <div className="aa-faint">{t.ats}</div>}
                                </td>
                                <td data-label="Status">
                                    <TaskStatusPill status={t.status} />
                                    {t.reason_code && <div className="aa-faint" style={{ marginTop: 4 }}>{reasonText(t.reason_code)}</div>}
                                    {t.not_charged && t.status !== 'removed' && t.status !== 'cancelled' && <div className="aa-faint" style={{ marginTop: 4 }}>Not charged</div>}
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
                                <td data-label="Score">{t.score ?? '—'}</td>
                                <td data-label="Submitted">{t.submitted_at ? fmtDate(t.submitted_at) : '—'}</td>
                                <td>
                                    <div className="aa-row" style={{ gap: 6 }}>
                                        {t.status === 'applied' && t.has_proof && <ProofButton batchId={batch.id} task={t} />}
                                        {t.apply_url && (
                                            <a className="aa-btn" href={t.apply_url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${t.company} job posting`}>
                                                <ExternalLink size={12} aria-hidden /> Job
                                            </a>
                                        )}
                                        {inReview && t.status === 'shortlisted' && (
                                            <button type="button" className="aa-btn is-danger" onClick={() => doRemove(t.id)} disabled={removing === t.id} aria-label={`Remove ${t.company} ${t.title}`}>
                                                {removing === t.id ? 'Removing…' : 'Remove'}
                                            </button>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}

export default function BatchDetailPage() {
    const { id } = useParams()
    const [params] = useSearchParams()
    const live = useAutoApplyRealtime()
    const q = useBatch(id, { live })
    const batch = q.data?.batch
    const counts = q.data?.counts || {}
    const tasks = q.data?.tasks || []
    const countdown = useCountdown(batch?.status === 'review' ? batch.review_until : null)

    return (
        <AALayout gate>
            {q.isLoading ? (
                <LoadingState label="Loading batch…" />
            ) : q.isError ? (
                <ErrorState err={q.error} onRetry={() => q.refetch()} title={q.error?.status === 404 ? 'Batch not found' : 'Could not load batch'} />
            ) : !batch ? (
                <EmptyState title="Batch not found" action={<Link to="/autoapply/batches" className="aa-btn">All batches</Link>} />
            ) : (
                <>
                    <p style={{ margin: '0 0 10px' }}><Link to="/autoapply/batches" style={{ color: 'var(--pop)', fontSize: '0.76rem', textDecoration: 'none' }}>← All batches</Link></p>
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
                        <section className="aa-card" aria-label="Progress">
                            <Progress used={batch.credits_used} total={batch.credits_total} />
                            {Object.keys(counts).length > 0 && (
                                <div className="aa-chips" style={{ marginTop: 12 }} aria-label="Jobs by status">
                                    {TASK_STATUS_ORDER.filter((s) => counts[s]).map((s) => (
                                        <span key={s} className="aa-chip">{taskStatusLabel(s)} <strong>{num(counts[s])}</strong></span>
                                    ))}
                                </div>
                            )}
                            {batch.status === 'refund_due' || batch.status === 'refunded' ? (
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
                            <section className="aa-card is-pop" aria-labelledby="rv-h">
                                <h2 id="rv-h" className="aa-h2">Review the shortlist</h2>
                                <p className="aa-muted" style={{ margin: '0 0 12px' }}>
                                    Remove any job you don&rsquo;t want. We start applying in{' '}
                                    <strong style={{ color: 'var(--bright)' }} aria-live="off">{countdown || 'a few hours'}</strong>
                                    {batch.review_until && <> (at {fmtDate(batch.review_until)})</>}, or approve now.
                                </p>
                            </section>
                        )}

                        <ChargeSummary charge={q.data?.charge} />

                        <MustCompaniesEditor key={(batch.must_companies || []).join('|')} batch={batch} />

                        <Controls batch={batch} />

                        <section aria-labelledby="tasks-h">
                            <h2 id="tasks-h" className="aa-h2">Jobs</h2>
                            <TaskTable batch={batch} tasks={tasks} />
                        </section>
                    </div>
                </>
            )}
        </AALayout>
    )
}

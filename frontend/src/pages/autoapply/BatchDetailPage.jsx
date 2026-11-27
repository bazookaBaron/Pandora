import { memo, useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ExternalLink, FileCheck2, Loader, Mail, Settings2 } from 'lucide-react'
import { safeHref } from './InterviewCard'
import { EmptyState, ErrorState, LoadingState, errorText } from '../../components/shared/states'
import { HelpChip, PageHeader, Progress, Row, Sheet, SmallTabs, StatusBanner, TabPanel } from '../../components/ui'
import { CTA, TERMS } from '../../lib/copy'
import { fetchTaskProof, useAutoApplyRealtime, useBatch, useBatchAction, useCompanySuggest, useSetMustCompanies } from '../../lib/useAutoApply'
import {
    AALayout, BatchStatusPill, EmptyArt, InlineConfirm, MustCompaniesInput, fmtDate, num, packTitle, reasonText, rupees, setupLinkFor,
} from './ui'

// Pack detail: progress bar, then Applied · Answers needed · Skipped as small tabs of one-line rows.
// A row opens a sheet with the details (company, role, time, proof link, the reason in plain words).
// Pause / resume / approve and must-apply companies live in the "Manage pack" sheet.

// Ticks every second on its own, so only this text re-renders, not the whole page.
function Countdown({ iso, fallback }) {
    const text = useCountdown(iso)
    return <>{text || fallback}</>
}

const shortDate = (iso) => {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
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
    return `${h}h ${String(m).padStart(2, '0')}m`
}

const CONFIRM_COPY = {
    pause: ['Pause this pack? Nothing new is sent until you resume. Unused applications stay saved.', 'Pause', 'neutral'],
    resume: ['Resume applying for this pack?', 'Resume', 'neutral'],
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
        cancel: false, // no-refund policy: a paid pack is paused, never cancelled (admin-only refunds)
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
                </div>
            )}
            {err && <ErrorState compact message={errorText(err)} />}
        </div>
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
            <button type="button" className="aa-btn aa-sheet-btn" onClick={open} disabled={busy} aria-label={`View proof of the ${task.company} application`}>
                {busy ? <Loader size={16} aria-hidden="true" /> : <FileCheck2 size={16} aria-hidden="true" />} See proof
            </button>
            {err && <p className="buy-err" role="alert">{err}</p>}
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
        <section className="aa-stack" aria-labelledby="must-h" style={{ gap: 8 }}>
            <div className="aa-spread">
                <h3 id="must-h" className="aa-h">Must-apply companies</h3>
                {editable && !editing && <button type="button" className="aa-btn" onClick={() => { setDraft(current); setEditing(true) }}>{current.length ? 'Edit' : 'Add'}</button>}
            </div>
            {editing ? (
                <div className="aa-stack">
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
                <div className="aa-chips">{current.map((c) => <span key={c} className="aa-chip">{c}</span>)}</div>
            ) : (
                <p className="aa-faint" style={{ margin: 0 }}>None. Add up to 10 to apply to first.</p>
            )}
        </section>
    )
}

const SKIPPED = ['skipped', 'failed', 'removed', 'cancelled']

// One compact line per job: "Company · Role" and a date (or the reason, on Skipped). Tap opens the sheet.
// Memoised: the page re-renders on every realtime/poll update; the list only needs to when its tasks change.
const TaskList = memo(function TaskList({ tasks, kind, onOpen }) {
    return (
        <ul className="aa-tl" aria-label={kind === 'answers' ? 'Jobs that need your answer' : kind === 'skipped' ? 'Skipped jobs' : 'Applied jobs'}>
            {tasks.map((t) => {
                const when = t.submitted_at || t.updated_at
                const meta = kind === 'skipped' ? reasonText(t.reason_code) || 'Skipped' : when ? shortDate(when) : ''
                return (
                    <li key={t.id}>
                        <Row title={`${t.company} · ${t.title}`} meta={meta} metaTone={kind === 'answers' ? 'attention' : undefined} onClick={() => onOpen(t)}
                            aria-label={`${t.company}, ${t.title}${meta ? `, ${meta}` : ''}`} />
                    </li>
                )
            })}
        </ul>
    )
})

function TaskSheet({ task, batchId, onClose }) {
    if (!task) return null
    const job = safeHref(task.apply_url)
    const isApplied = task.status === 'applied'
    const isAnswers = task.status === 'needs_you'
    const when = task.submitted_at || task.updated_at
    return (
        <Sheet open={!!task} onClose={onClose} title={task.company} description={task.title}
            footer={isAnswers ? <Link to="/autoapply/needs-you" className="sys-tone-btn aa-tone">{CTA.answerNow}</Link> : undefined}>
            <dl className="aa-dl">
                <div><dt>Status</dt><dd>{isApplied ? 'Applied' : isAnswers ? TERMS.answersNeeded.one : TERMS.skipped.one}</dd></div>
                {when && <div><dt>{isApplied ? 'Applied on' : 'Updated'}</dt><dd><time dateTime={when}>{fmtDate(when)}</time></dd></div>}
                {!isApplied && !isAnswers && <div><dt>Why</dt><dd>{reasonText(task.reason_code) || 'We could not apply to this job.'} No credit used.</dd></div>}
                {isAnswers && <div><dt>Why</dt><dd>The form asked something we do not know yet.</dd></div>}
            </dl>
            <div className="aa-stack" style={{ marginTop: 14, gap: 8 }}>
                {isApplied && task.has_proof && <ProofButton batchId={batchId} task={task} />}
                {isApplied && task.confirmation_mail && (
                    <Link className="aa-btn aa-sheet-btn" to={`/autoapply/inbox?mail=${encodeURIComponent(task.confirmation_mail.id)}`}>
                        <Mail size={16} aria-hidden="true" /> Confirmation mail
                    </Link>
                )}
                {job && (
                    <a className="aa-btn aa-sheet-btn" href={job} target="_blank" rel="noopener noreferrer">
                        <ExternalLink size={16} aria-hidden="true" /> Open job posting
                    </a>
                )}
            </div>
        </Sheet>
    )
}

function ManageSheet({ open, onClose, batch, live }) {
    return (
        <Sheet open={open} onClose={onClose} title="Manage pack">
            <div className="aa-stack" style={{ gap: 18 }}>
                <dl className="aa-dl">
                    {batch.purchased_at && <div><dt>Bought</dt><dd>{shortDate(batch.purchased_at)}</dd></div>}
                    {batch.price_paise != null && <div><dt>Paid</dt><dd>{rupees(batch.price_paise)}</dd></div>}
                    {batch.expires_at && <div><dt>Ends</dt><dd>{shortDate(batch.expires_at)}</dd></div>}
                    <div><dt>Updates</dt><dd>{live ? 'Live' : 'Every 15 s'}</dd></div>
                </dl>
                <p className="aa-muted" style={{ margin: 0 }}>Credits are only used for submitted applications.</p>
                <Controls batch={batch} />
                <MustCompaniesEditor key={(batch.must_companies || []).join('|')} batch={batch} />
            </div>
        </Sheet>
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
    const skippedTasks = useMemo(() => (allTasks || []).filter((t) => SKIPPED.includes(t.status)), [allTasks])
    const notApplied = q.data?.live?.buckets?.not_applied || 0
    const skippedCount = Math.max(notApplied, skippedTasks.length)
    const [tab, setTab] = useState(null)
    const [openTask, setOpenTask] = useState(null)
    const [manage, setManage] = useState(false)
    const curTab = tab || (needTasks.length ? 'answers' : 'applied')

    let banner = null
    if (batch) {
        if (params.get('new')) {
            banner = <StatusBanner tone="ok" text={batch.status === 'waiting_profile' ? 'Payment confirmed. Finish your profile to start.' : 'Payment confirmed. We are finding jobs now.'} />
        } else if (needTasks.length) {
            banner = <StatusBanner tone="action" text={`${num(needTasks.length)} job${needTasks.length === 1 ? ' needs' : 's need'} your answer`} action={{ label: CTA.answerNow, to: '/autoapply/needs-you' }} />
        } else if (batch.status === 'waiting_profile') {
            banner = <StatusBanner tone="warn" text="Waiting for your profile" action={{ label: 'Finish', to: setupLinkFor(batch.waiting_detail?.missing) }} />
        } else if (batch.status === 'review') {
            banner = <StatusBanner tone="info" text={<>Applying starts in <Countdown iso={batch.review_until} fallback="a few hours" /></>} action={{ label: 'Approve', onClick: () => setManage(true) }} />
        } else if (batch.status === 'waiting_supply') {
            banner = <StatusBanner tone="info" text="Waiting for new matching jobs" />
        }
    }

    return (
        <AALayout gate>
            {q.isLoading ? (
                <LoadingState label="Loading pack…" />
            ) : q.isError ? (
                <ErrorState err={q.error} onRetry={() => q.refetch()} title={q.error?.status === 404 ? 'Pack not found' : 'Could not load pack'} />
            ) : !batch ? (
                <EmptyState title="Pack not found" action={<Link to="/autoapply" className="aa-btn">Auto Apply</Link>} />
            ) : (
                <>
                    <PageHeader
                        section="autoapply"
                        title={packTitle(batch)}
                        subtitle={`${num(batch.credits_used)} of ${num(batch.credits_total)} applied`}
                        back={{ to: '/autoapply', label: 'Auto Apply' }}
                        aside={<BatchStatusPill status={batch.status} />}
                    />
                    {banner && <div className="aa-gap">{banner}</div>}

                    <section className="aa-gap" aria-label="Progress">
                        <Progress value={batch.credits_used} max={batch.credits_total} label="Applications sent" showText={false} />
                        {q.data?.live?.message && (
                            <p className="aa-pack-msg" role="status" aria-live="polite">
                                {(q.data.live.phase === 'applying' || q.data.live.phase === 'starting') && <span className="aa-flow-dot" aria-hidden="true" />}
                                <span>{q.data.live.message}</span>
                            </p>
                        )}
                        {!q.data?.live && ['refund_due', 'refunding', 'refunded'].includes(batch.status) && (
                            // fallback only: the live line above already says this in one sentence (with the amount when > 0)
                            <p className="aa-pack-msg">
                                {batch.status === 'refunded'
                                    ? (Number(batch.refund_paise) > 0 ? `Refunded ${rupees(batch.refund_paise)}.` : 'This payment was refunded.')
                                    : 'This payment is being refunded.'}
                            </p>
                        )}
                    </section>

                    <div className="aa-tabsbar">
                        <SmallTabs idPrefix="pack" label="Pack jobs" section="autoapply" value={curTab} onChange={setTab}
                            items={[
                                { value: 'applied', label: TERMS.applied.one, count: appliedTasks.length },
                                { value: 'answers', label: TERMS.answersNeeded.one, count: needTasks.length },
                                { value: 'skipped', label: TERMS.skipped.one, count: skippedCount },
                            ]} />
                        <HelpChip term="skipped" />
                        <button type="button" className="aa-icon-only" onClick={() => setManage(true)} aria-label="Manage pack">
                            <Settings2 size={20} aria-hidden="true" />
                        </button>
                    </div>

                    <TabPanel idPrefix="pack" value="applied" active={curTab === 'applied'}>
                        {appliedTasks.length ? <TaskList tasks={appliedTasks} kind="applied" onOpen={setOpenTask} /> : (
                            <EmptyState compact icon={<EmptyArt kind="jobs" tone="success" />} title="Nothing sent yet" message="This updates on its own." />
                        )}
                    </TabPanel>
                    <TabPanel idPrefix="pack" value="answers" active={curTab === 'answers'}>
                        {needTasks.length ? <TaskList tasks={needTasks} kind="answers" onOpen={setOpenTask} /> : (
                            <EmptyState compact icon={<EmptyArt kind="jobs" tone="success" />} title="No questions for you" />
                        )}
                    </TabPanel>
                    <TabPanel idPrefix="pack" value="skipped" active={curTab === 'skipped'}>
                        {skippedTasks.length ? <TaskList tasks={skippedTasks} kind="skipped" onOpen={setOpenTask} /> : null}
                        {skippedCount > skippedTasks.length && (
                            <p className="aa-faint" style={{ marginTop: 10 }}>{num(skippedCount - skippedTasks.length)} older skipped jobs are cleared after 30 days. No credit used.</p>
                        )}
                        {!skippedCount && <EmptyState compact icon={<EmptyArt kind="jobs" tone="history" />} title="Nothing skipped" />}
                    </TabPanel>

                    <TaskSheet task={openTask} batchId={batch.id} onClose={() => setOpenTask(null)} />
                    <ManageSheet open={manage} onClose={() => setManage(false)} batch={batch} live={live} />
                </>
            )}
        </AALayout>
    )
}

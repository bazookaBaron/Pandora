import { useEffect, useMemo, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { EmptyState, ErrorState, LoadingState } from '../../components/shared/states'
import { GuideNextCta } from '../../components/onboarding/AAProgressGuide'
import { PageHeader, StatusBanner, Stepper } from '../../components/ui'
import { useNeedsYouForm, useSaveNeedsYouForm } from '../../lib/useAutoApply'
import { AALayout, setupLinkFor } from './ui'
import { safeHref } from './InterviewCard'
import './needsyou.css'

// Answers needed = ONE form at the end of a pack: every detail that was missing across all the application forms
// we could not submit (deduped), one block per site that needs an account step, and "did it go through?"
// checks. Shown as a stepper, one group per screen; the last Continue saves everything once: answers go to
// your saved answers and those applications are retried.

function JobLine({ job }) {
    const link = safeHref(job.apply_url)
    const name = [job.company || 'Unknown company', job.title].filter(Boolean).join(' · ')
    return (
        <span className="ny-job">
            <span className="ny-job-name" title={name}>{name}</span>
            {link && <a href={link} target="_blank" rel="noopener noreferrer" className="ny-link" aria-label={`Open ${name}`}><ExternalLink size={14} aria-hidden /><span className="ny-link-text"> Open</span></a>}
        </span>
    )
}

function Control({ field, value, onChange }) {
    const id = `ny-f-${field.id}`
    const common = { id, name: field.id, 'aria-describedby': `${id}-h` }
    const opts = field.options || []
    switch (field.type) {
        case 'yesno':
            return (
                <div className="ny-seg" role="radiogroup" aria-labelledby={`${id}-l`}>
                    {opts.map((o) => (
                        <label key={o.value} className={`ny-seg-opt${String(value) === String(o.value) ? ' is-on' : ''}`}>
                            <input type="radio" name={field.id} value={o.value} checked={String(value) === String(o.value)} onChange={() => onChange(o.value)} />
                            {o.label}
                        </label>
                    ))}
                </div>
            )
        case 'select':
            return (
                <select {...common} className="input-field provider-select" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
                    <option value="">Choose…</option>
                    {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
            )
        case 'multiselect': {
            const picked = String(value || '').split(',').map((s) => s.trim()).filter(Boolean)
            const toggle = (v) => onChange((picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v]).join(','))
            return (
                <div className="ny-multi" role="group" aria-labelledby={`${id}-l`}>
                    {opts.map((o) => (
                        <label key={o.value} className="ny-check">
                            <input type="checkbox" checked={picked.includes(o.value)} onChange={() => toggle(o.value)} /> {o.label}
                        </label>
                    ))}
                </div>
            )
        }
        case 'date':
            return <input {...common} type="date" className="input-field" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
        case 'number':
            return <input {...common} type="number" min="0" inputMode="decimal" className="input-field" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
        case 'textarea':
            return <textarea {...common} className="input-field ny-textarea" rows={4} maxLength={field.max_length} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
        default:
            return <input {...common} className="input-field" maxLength={field.max_length} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    }
}

function initialAnswers(fields) {
    const out = {}
    for (const f of fields || []) out[f.id] = f.value ?? (f.suggestion != null ? String(f.suggestion) : '')
    return out
}

const FIELDS_PER_SCREEN = 3

export default function NeedsYouPage() {
    const q = useNeedsYouForm()
    const save = useSaveNeedsYouForm()
    const data = q.data
    const fields = useMemo(() => data?.fields || [], [data])
    const sites = useMemo(() => data?.sites || [], [data])
    const unconfirmed = useMemo(() => data?.unconfirmed || [], [data])
    const profile = data?.profile || null
    const accumulating = data?.accumulating || 0

    const [answers, setAnswers] = useState({})
    const [siteDone, setSiteDone] = useState({})
    const [manual, setManual] = useState({})
    const [unconf, setUnconf] = useState({})
    const [step, setStep] = useState(1)
    const [saved, setSaved] = useState(false)
    // reset the form whenever the server sends a different one (after a save, or new items became ready)
    const formKey = JSON.stringify([fields.map((f) => f.id), sites.map((s) => s.id), unconfirmed.map((u) => u.item_id)])
    useEffect(() => {
        setAnswers(initialAnswers(fields))
        setSiteDone({})
        setManual({})
        setUnconf({})
        setStep(1)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [formKey])

    const retrySites = sites.filter((s) => s.kind !== 'manual')
    const manualSites = sites.filter((s) => s.kind === 'manual')
    const filled = fields.filter((f) => String(answers[f.id] ?? '').trim()).length
    const anything = filled > 0 || Object.values(siteDone).some(Boolean) || Object.values(manual).some(Boolean) || Object.values(unconf).some(Boolean)
    const empty = fields.length === 0 && sites.length === 0 && unconfirmed.length === 0

    // one group per screen: details in threes, then each site, then the manual sites, then "did it go through?"
    const screens = []
    for (let i = 0; i < fields.length; i += FIELDS_PER_SCREEN) screens.push({ kind: 'fields', list: fields.slice(i, i + FIELDS_PER_SCREEN) })
    for (const s of retrySites) screens.push({ kind: 'site', site: s })
    if (manualSites.length) screens.push({ kind: 'manual' })
    if (unconfirmed.length) screens.push({ kind: 'unconfirmed' })
    const total = screens.length
    const k = Math.min(step, Math.max(1, total))
    const cur = screens[k - 1]
    const last = k >= total

    function submit() {
        if (save.isPending || !anything) return
        const body = { answers: {}, sites: {}, manual: {}, unconfirmed: {} }
        for (const f of fields) {
            const v = String(answers[f.id] ?? '').trim()
            if (v) body.answers[f.id] = v
        }
        for (const [key, v] of Object.entries(siteDone)) if (v) body.sites[key] = 'done'
        for (const [key, v] of Object.entries(manual)) if (v) body.manual[key] = v
        for (const [key, v] of Object.entries(unconf)) if (v) body.unconfirmed[key] = v
        save.mutate(body, { onSuccess: () => setSaved(true) })
    }

    let title = ''
    let hint = ''
    let body = null
    if (cur?.kind === 'fields') {
        title = 'A few details'
        hint = `${filled} of ${fields.length} answered. Blank ones can wait.`
        body = (
            <div className="aa-stack" style={{ gap: 18 }}>
                {cur.list.map((f) => {
                    const id = `ny-f-${f.id}`
                    return (
                        <div key={f.id} className="aa-field ny-field">
                            <label id={`${id}-l`} htmlFor={id} className="field-label ny-label">{f.label}</label>
                            <Control field={f} value={answers[f.id]} onChange={(v) => setAnswers((a) => ({ ...a, [f.id]: v }))} />
                            <div id={`${id}-h`} className="field-hint">
                                {f.count > 1 ? `Asked by ${f.count} jobs` : 'Asked by 1 job'}
                                {f.companies?.length ? ` (${f.companies.slice(0, 3).join(', ')}${f.companies.length > 3 ? '…' : ''})` : ''}
                                {f.help ? `. ${f.help}` : ''}
                            </div>
                        </div>
                    )
                })}
            </div>
        )
    } else if (cur?.kind === 'site') {
        const s = cur.site
        title = s.title
        hint = s.kind === 'verify_email' ? 'Click the link in the mail (Inbox), then tick below.' : 'Sign in on the site once, then tick below.'
        body = (
            <div className="aa-stack">
                <ul className="ny-jobs">{s.jobs.map((j) => <li key={j.item_id}><JobLine job={j} /></li>)}</ul>
                <label className="ny-check ny-big">
                    <input type="checkbox" checked={!!siteDone[s.id]} onChange={(e) => setSiteDone((d) => ({ ...d, [s.id]: e.target.checked }))} />
                    Done: retry {s.jobs.length === 1 ? 'this job' : `these ${s.jobs.length} jobs`}
                </label>
            </div>
        )
    } else if (cur?.kind === 'manual') {
        title = 'Sites we cannot apply on'
        hint = 'Blocked by a captcha or social sign-in. No credit used.'
        body = (
            <div className="aa-stack">
                {manualSites.map((s) => (
                    <div key={s.id} className="ny-site">
                        <div className="ny-site-name">{s.site}</div>
                        <ul className="ny-jobs">
                            {s.jobs.map((j) => (
                                <li key={j.item_id} className="ny-job-row">
                                    <JobLine job={j} />
                                    <select className="input-field provider-select ny-mini" aria-label={`${j.company || 'Job'}: what happened`}
                                        value={manual[j.item_id] || ''} onChange={(e) => setManual((m) => ({ ...m, [j.item_id]: e.target.value }))}>
                                        <option value="">Leave for now</option>
                                        <option value="applied">I applied myself</option>
                                        <option value="skip">Skip this job</option>
                                    </select>
                                </li>
                            ))}
                        </ul>
                    </div>
                ))}
            </div>
        )
    } else if (cur?.kind === 'unconfirmed') {
        title = 'Did these go through?'
        hint = 'We saw no confirmation. Yes uses one credit. No means we retry.'
        body = (
            <ul className="ny-jobs">
                {unconfirmed.map((u) => (
                    <li key={u.item_id} className="ny-job-row">
                        <JobLine job={u} />
                        <span className="ny-yn">
                            <label className="ny-check">
                                <input type="checkbox" checked={unconf[u.item_id] === 'yes'} onChange={(e) => setUnconf((m) => ({ ...m, [u.item_id]: e.target.checked ? 'yes' : '' }))} /> Yes
                            </label>
                            <label className="ny-check">
                                <input type="checkbox" checked={unconf[u.item_id] === 'no'} onChange={(e) => setUnconf((m) => ({ ...m, [u.item_id]: e.target.checked ? 'no' : '' }))} /> No
                            </label>
                        </span>
                    </li>
                ))}
            </ul>
        )
    }

    const missingCount = (profile?.missing || []).length
    return (
        <AALayout gate>
            <PageHeader section="autoapply" title="Answers needed" subtitle="Answer once. We keep applying." back={{ to: '/autoapply', label: 'Auto Apply' }} />
            {q.isLoading ? (
                <LoadingState label="Loading…" />
            ) : q.isError ? (
                <ErrorState err={q.error} onRetry={() => q.refetch()} title="Could not load" />
            ) : (
                <>
                    {profile && (
                        <div className="aa-gap">
                            <StatusBanner tone="warn" text={`A pack waits for your profile: ${missingCount} item${missingCount === 1 ? '' : 's'} missing`}
                                action={{ label: 'Fix', to: setupLinkFor(profile.missing) }} />
                        </div>
                    )}
                    {empty ? (
                        <EmptyState
                            icon="✅"
                            title={saved ? 'Done. We will keep applying.' : accumulating > 0 ? 'Nothing to answer yet' : 'No questions for you'}
                            message={accumulating > 0
                                ? `${accumulating} job${accumulating === 1 ? '' : 's'} will need a detail. We ask once, at the end.`
                                : 'New questions show up here.'}
                            action={<GuideNextCta fallback={{ to: '/autoapply', label: 'Back to Auto Apply' }} />}
                        />
                    ) : (
                        <Stepper section="autoapply" step={k} total={total} title={title} hint={hint}
                            onBack={k > 1 ? () => setStep(k - 1) : undefined}
                            onNext={() => (last ? submit() : setStep(k + 1))}
                            canNext={!last || anything} busy={save.isPending}
                            nextLabel={last ? 'Save and retry' : 'Continue'}
                            error={last && !anything ? 'Answer at least one thing to save.' : null}>
                            {body}
                        </Stepper>
                    )}
                </>
            )}
        </AALayout>
    )
}

import { useEffect, useMemo, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { EmptyState, ErrorState, LoadingState } from '../../components/shared/states'
import { GuideNextCta } from '../../components/onboarding/AAProgressGuide'
import { useNeedsYouForm, useSaveNeedsYouForm } from '../../lib/useAutoApply'
import { AALayout, PageHeader, ProfileMissing } from './ui'
import { safeHref } from './InterviewCard'
import './needsyou.css'

// Needs you = ONE form at the end of a batch: every detail that was missing across all the application forms
// we could not submit (deduped), one block per site that needs an account step, and "did it go through?"
// checks. One Save: answers go to your saved answers and those applications are retried.

function JobLine({ job }) {
    const link = safeHref(job.apply_url)
    const name = [job.company || 'Unknown company', job.title].filter(Boolean).join(' · ')
    return (
        <span className="ny-job">
            <span className="ny-job-name" title={name}>{name}</span>
            {link && <a href={link} target="_blank" rel="noopener noreferrer" className="ny-link" aria-label={`Open ${name}`}><ExternalLink size={11} aria-hidden /><span className="ny-link-text"> Open</span></a>}
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
    // reset the form whenever the server sends a different one (after a save, or new items became ready)
    const formKey = JSON.stringify([fields.map((f) => f.id), sites.map((s) => s.id), unconfirmed.map((u) => u.item_id)])
    useEffect(() => {
        setAnswers(initialAnswers(fields))
        setSiteDone({})
        setManual({})
        setUnconf({})
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [formKey])

    const retrySites = sites.filter((s) => s.kind !== 'manual')
    const manualSites = sites.filter((s) => s.kind === 'manual')
    const filled = fields.filter((f) => String(answers[f.id] ?? '').trim()).length
    const anything = filled > 0 || Object.values(siteDone).some(Boolean) || Object.values(manual).some(Boolean) || Object.values(unconf).some(Boolean)
    const empty = fields.length === 0 && sites.length === 0 && unconfirmed.length === 0

    function submit(e) {
        e.preventDefault()
        if (save.isPending || !anything) return
        const body = { answers: {}, sites: {}, manual: {}, unconfirmed: {} }
        for (const f of fields) {
            const v = String(answers[f.id] ?? '').trim()
            if (v) body.answers[f.id] = v
        }
        for (const [k, v] of Object.entries(siteDone)) if (v) body.sites[k] = 'done'
        for (const [k, v] of Object.entries(manual)) if (v) body.manual[k] = v
        for (const [k, v] of Object.entries(unconf)) if (v) body.unconfirmed[k] = v
        save.mutate(body)
    }

    return (
        <AALayout gate>
            <PageHeader
                title="Needs you"
                lead="Fill these in once and we retry those applications."
            />
            {q.isLoading ? (
                <LoadingState label="Loading…" />
            ) : q.isError ? (
                <ErrorState err={q.error} onRetry={() => q.refetch()} title="Could not load" />
            ) : (
                <div className="aa-stack">
                    {profile && <ProfileMissing missing={profile.missing} lead="A batch waits for your profile. Missing:" />}

                    {empty ? (
                        <EmptyState
                            icon="✅"
                            title={accumulating > 0 ? 'Nothing to fill in yet' : 'Nothing needs you right now'}
                            message={accumulating > 0
                                ? `${accumulating} application${accumulating === 1 ? '' : 's'} will need a detail; we ask once, at the end.`
                                : 'Questions we cannot answer show up here.'}
                            action={<GuideNextCta fallback={{ to: '/autoapply', label: 'Open batches' }} />}
                        />
                    ) : (
                        <form className="ny-form aa-stack" onSubmit={submit} noValidate>
                            {accumulating > 0 && (
                                <p className="aa-note is-info ny-flat" role="status">
                                    {accumulating} more still in progress.
                                </p>
                            )}

                            {fields.length > 0 && (
                                <section className="aa-card ny-section" aria-labelledby="ny-q-h">
                                    <h2 id="ny-q-h" className="ny-h">Missing details <span className="aa-faint">({filled}/{fields.length})</span></h2>
                                    <div className="ny-grid">
                                        {fields.map((f) => {
                                            const id = `ny-f-${f.id}`
                                            return (
                                                <div key={f.id} className={`aa-field ny-field${f.type === 'textarea' || f.type === 'multiselect' ? ' is-wide' : ''}`}>
                                                    <label id={`${id}-l`} htmlFor={id} className="field-label ny-label">{f.label}</label>
                                                    <Control field={f} value={answers[f.id]} onChange={(v) => setAnswers((a) => ({ ...a, [f.id]: v }))} />
                                                    <div id={`${id}-h`} className="field-hint">
                                                        {f.count > 1 ? `Asked by ${f.count} applications` : 'Asked by 1 application'}
                                                        {f.companies?.length ? ` (${f.companies.slice(0, 3).join(', ')}${f.companies.length > 3 ? '…' : ''})` : ''}
                                                        {f.help ? `. ${f.help}` : ''}
                                                    </div>
                                                </div>
                                            )
                                        })}
                                    </div>
                                </section>
                            )}

                            {retrySites.map((s) => (
                                <section key={s.id} className="aa-card ny-section" aria-labelledby={`ny-s-${s.id}`}>
                                    <h2 id={`ny-s-${s.id}`} className="ny-h">{s.title}</h2>
                                    <p className="aa-muted ny-sub">
                                        {s.kind === 'verify_email'
                                            ? 'Click the link in the verification mail (Inbox), then tick below.'
                                            : 'Sign in on the site once, then tick below.'}
                                    </p>
                                    <ul className="ny-jobs">{s.jobs.map((j) => <li key={j.item_id}><JobLine job={j} /></li>)}</ul>
                                    <label className="ny-check">
                                        <input type="checkbox" checked={!!siteDone[s.id]} onChange={(e) => setSiteDone((d) => ({ ...d, [s.id]: e.target.checked }))} />
                                        Done: retry {s.jobs.length === 1 ? 'this application' : `these ${s.jobs.length} applications`}
                                    </label>
                                </section>
                            ))}

                            {manualSites.length > 0 && (
                                <section className="aa-card ny-section" aria-labelledby="ny-m-h">
                                    <h2 id="ny-m-h" className="ny-h">Sites we cannot apply on for you</h2>
                                    <p className="aa-muted ny-sub">Blocked by a captcha or social sign-in. No credit used.</p>
                                    {manualSites.map((s) => (
                                        <div key={s.id} className="ny-site">
                                            <div className="ny-site-name">{s.site}</div>
                                            <ul className="ny-jobs">
                                                {s.jobs.map((j) => (
                                                    <li key={j.item_id} className="ny-job-row">
                                                        <JobLine job={j} />
                                                        <select
                                                            className="input-field provider-select ny-mini"
                                                            aria-label={`${j.company || 'Job'}: what happened`}
                                                            value={manual[j.item_id] || ''}
                                                            onChange={(e) => setManual((m) => ({ ...m, [j.item_id]: e.target.value }))}
                                                        >
                                                            <option value="">Leave for now</option>
                                                            <option value="applied">I applied myself</option>
                                                            <option value="skip">Skip this job</option>
                                                        </select>
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    ))}
                                </section>
                            )}

                            {unconfirmed.length > 0 && (
                                <section className="aa-card ny-section" aria-labelledby="ny-u-h">
                                    <h2 id="ny-u-h" className="ny-h">Did these go through?</h2>
                                    <p className="aa-muted ny-sub">No confirmation seen. Yes uses one credit; No retries.</p>
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
                                </section>
                            )}

                            <div className="ny-actions">
                                <button type="submit" className="aa-btn is-primary" disabled={save.isPending || !anything}>
                                    {save.isPending ? 'Saving…' : 'Save and retry'}
                                </button>
                                <span className="aa-faint">Blank fields stay open for later. Nothing here uses a credit unless an application is submitted.</span>
                            </div>
                        </form>
                    )}
                </div>
            )}
        </AALayout>
    )
}

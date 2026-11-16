import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ErrorState, LoadingState, errorText } from '../../components/shared/states'
import {
    useAnswers, useAutoApplyMe, useSaveAnswers, useSaveProfile, useUploadResume,
} from '../../lib/useAutoApply'
import { AALayout, CopyButton, PageHeader } from './ui'
import NotifyButton from './NotifyButton'

const STEPS = [
    { id: 'resume', label: 'Resume' },
    { id: 'answers', label: 'Answers' },
    { id: 'prefs', label: 'Preferences' },
    { id: 'email', label: 'Email' },
    { id: 'consent', label: 'Confirm' },
]


const MAX_RESUME_BYTES = 5 * 1024 * 1024

// /me may hand back either the aa_profiles row or just its `profile` jsonb.
function profileJson(me) {
    const p = me?.profile
    if (p && typeof p === 'object' && p.profile && typeof p.profile === 'object') return p.profile
    return p && typeof p === 'object' ? p : {}
}
function prefsJson(me) {
    return me?.prefs || me?.profile?.prefs || {}
}
function resumePath(me) {
    return me?.profile?.resume_path || me?.resume_path || null
}

const labelize = (k) => k.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

function StepNote({ state }) {
    if (!state) return null
    if (state.error) return <ErrorState compact message={errorText(state.error)} />
    return <div className="aa-note is-ok" role="status">{state.ok}</div>
}

// ── Step 1: resume ─────────────────────────────────────────────────
function DraftField({ k, value, onChange }) {
    const id = `draft-${k}`
    if (Array.isArray(value) && value.every((v) => typeof v !== 'object' || v === null)) {
        return (
            <div className="aa-field">
                <label className="field-label" htmlFor={id}>{labelize(k)} <span className="aa-faint">(comma separated)</span></label>
                <textarea id={id} className="input-field" rows={2} value={value.join(', ')}
                    onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
            </div>
        )
    }
    if (Array.isArray(value)) {
        return (
            <fieldset className="aa-field" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="field-label">{labelize(k)}</legend>
                <div className="aa-stack">
                    {value.map((item, i) => (
                        <div key={i} className="aa-card" style={{ padding: 12, background: 'var(--surface)' }}>
                            <div className="aa-grid-2">
                                {Object.entries(item || {}).filter(([, v]) => typeof v !== 'object' || v === null).map(([ik, iv]) => (
                                    <div key={ik} className="aa-field">
                                        <label className="field-label" htmlFor={`${id}-${i}-${ik}`}>{labelize(ik)}</label>
                                        <input id={`${id}-${i}-${ik}`} className="input-field" value={iv ?? ''}
                                            onChange={(e) => {
                                                const next = value.slice()
                                                next[i] = { ...item, [ik]: e.target.value }
                                                onChange(next)
                                            }} />
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </fieldset>
        )
    }
    if (value && typeof value === 'object') return null
    return (
        <div className="aa-field">
            <label className="field-label" htmlFor={id}>{labelize(k)}</label>
            <input id={id} className="input-field" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
        </div>
    )
}

function ResumeStep({ me, onNext, draft, setDraft }) {
    const upload = useUploadResume()
    const save = useSaveProfile()
    const fileRef = useRef(null)
    const [fileErr, setFileErr] = useState('')
    const [note, setNote] = useState(null)
    const onFile = me ? resumePath(me) : null

    function pick(e) {
        const f = e.target.files?.[0]
        setFileErr('')
        setNote(null)
        if (!f) return
        if (!/\.(pdf|docx)$/i.test(f.name)) { setFileErr('Upload a PDF or DOCX file.'); return }
        if (f.size > MAX_RESUME_BYTES) { setFileErr('That file is over 5 MB.'); return }
        upload.mutate(f, {
            onSuccess: (res) => setDraft(res?.parsed || {}),
            onError: (err) => setFileErr(errorText(err)),
        })
    }

    function saveDraft() {
        setNote(null)
        save.mutate({ profile: draft }, {
            onSuccess: () => { setNote({ ok: 'Profile saved.' }); onNext() },
            onError: (error) => setNote({ error }),
        })
    }

    const entries = Object.entries(draft || {})

    return (
        <section className="aa-card aa-stack" aria-labelledby="st-resume">
            <h2 id="st-resume" className="aa-h2">Resume</h2>
            <p className="aa-muted" style={{ margin: 0 }}>
                We read your resume to fill application forms. PDF or DOCX, up to 5 MB.
                {onFile && ' A resume is already on file; upload again to replace it.'}
            </p>
            <div className="aa-row">
                <label className="aa-btn is-primary" htmlFor="aa-resume-file" style={{ cursor: upload.isPending ? 'wait' : 'pointer' }}>
                    {upload.isPending ? 'Reading resume…' : onFile ? 'Replace resume' : 'Upload resume'}
                </label>
                <input id="aa-resume-file" ref={fileRef} type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    className="aa-sr" onChange={pick} disabled={upload.isPending} />
                {upload.isPending && <LoadingState compact label="" />}
            </div>
            {fileErr && <ErrorState compact message={fileErr} />}

            {entries.length > 0 && (
                <>
                    <div className="aa-note is-info">Check what we read and fix anything wrong. This is what goes into your applications.</div>
                    <div className="aa-stack">
                        {entries.map(([k, v]) => (
                            <DraftField key={k} k={k} value={v} onChange={(nv) => setDraft({ ...draft, [k]: nv })} />
                        ))}
                    </div>
                </>
            )}
            <StepNote state={note} />
            <div className="aa-row">
                {entries.length > 0 ? (
                    <button type="button" className="aa-btn is-primary" onClick={saveDraft} disabled={save.isPending}>
                        {save.isPending ? 'Saving…' : 'Save and continue'}
                    </button>
                ) : (
                    <button type="button" className="aa-btn" onClick={onNext} disabled={!onFile}>Continue</button>
                )}
            </div>
        </section>
    )
}

// ── Step 2: standard answers ───────────────────────────────────────
function AnswerInput({ q, value, onChange }) {
    const id = `ans-${q.key}`
    const common = { id, className: 'input-field', value: value ?? '', onChange: (e) => onChange(e.target.value), required: !!q.required, 'aria-describedby': q.help ? `${id}-help` : undefined }
    let input
    if (q.type === 'select' && Array.isArray(q.options)) {
        input = (
            <select {...common} className="input-field provider-select">
                <option value="">Choose…</option>
                {q.options.map((o) => {
                    const val = typeof o === 'object' ? o.value : o
                    const lab = typeof o === 'object' ? (o.label ?? o.value) : o
                    return <option key={val} value={val}>{lab}</option>
                })}
            </select>
        )
    } else if (q.type === 'number') {
        input = <input {...common} type="number" inputMode="decimal" step="any" />
    } else if (q.type === 'date') {
        input = <input {...common} type="date" />
    } else {
        input = <input {...common} type="text" />
    }
    return (
        <div className="aa-field">
            <label className="field-label" htmlFor={id}>
                {q.label}{q.required && <span style={{ color: 'var(--warm)' }} aria-hidden> *</span>}
            </label>
            {input}
            {q.help && <div id={`${id}-help`} className="field-hint">{q.help}</div>}
        </div>
    )
}

const draftToFields = {
    first_name: 'fields.first_name', last_name: 'fields.last_name', phone: 'fields.phone',
    linkedin: 'fields.linkedin', github: 'fields.github', website: 'fields.website',
    current_company: 'fields.current_company', current_title: 'fields.current_title',
    city: 'fields.city', state: 'fields.state', country: 'fields.country',
}

function AnswersStep({ onNext, draft }) {
    const answersQ = useAnswers()
    const save = useSaveAnswers()
    const [values, setValues] = useState({})
    const [note, setNote] = useState(null)
    const seeded = useRef(false)

    useEffect(() => {
        if (!answersQ.data || seeded.current) return
        seeded.current = true
        const base = { ...(answersQ.data.answers || {}) }
        // Pre-fill empty contact fields from the parsed resume draft.
        const d = draft || {}
        if (d.name && !d.first_name) {
            const parts = String(d.name).trim().split(/\s+/)
            if (!base['fields.first_name']) base['fields.first_name'] = parts[0] || ''
            if (!base['fields.last_name']) base['fields.last_name'] = parts.slice(1).join(' ')
        }
        for (const [dk, key] of Object.entries(draftToFields)) {
            if (d[dk] && !base[key]) base[key] = String(d[dk])
        }
        setValues(base)
    }, [answersQ.data, draft])

    const groups = useMemo(() => {
        const qs = answersQ.data?.questions || []
        return [
            ['Contact and profile', qs.filter((q) => q.key.startsWith('fields.'))],
            ['Application facts', qs.filter((q) => q.key.startsWith('facts.'))],
            ['Learned answers', qs.filter((q) => !q.key.startsWith('fields.') && !q.key.startsWith('facts.'))],
        ].filter(([, list]) => list.length > 0)
    }, [answersQ.data])

    if (answersQ.isLoading) return <LoadingState label="Loading questions…" />
    if (answersQ.isError) return <ErrorState err={answersQ.error} onRetry={() => answersQ.refetch()} title="Could not load questions" />

    const qs = answersQ.data?.questions || []
    const missing = qs.filter((q) => q.required && !String(values[q.key] ?? '').trim())

    function submit(e) {
        e.preventDefault()
        setNote(null)
        if (missing.length) { setNote({ error: new Error(`Fill the required questions: ${missing.slice(0, 3).map((q) => q.label).join(', ')}${missing.length > 3 ? '…' : ''}`) }); return }
        const out = {}
        for (const q of qs) if (values[q.key] !== undefined && values[q.key] !== '') out[q.key] = String(values[q.key])
        save.mutate(out, {
            onSuccess: () => { setNote({ ok: 'Answers saved.' }); onNext() },
            onError: (error) => setNote({ error }),
        })
    }

    return (
        <form className="aa-card aa-stack" onSubmit={submit} aria-labelledby="st-answers" noValidate>
            <h2 id="st-answers" className="aa-h2">Standard answers</h2>
            <p className="aa-muted" style={{ margin: 0 }}>These answer the questions most application forms ask. Fields marked * are required.</p>
            {groups.map(([title, list]) => (
                <fieldset key={title} style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend className="aa-faint" style={{ fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10 }}>{title}</legend>
                    <div className="aa-grid-2">
                        {list.map((q) => (
                            <AnswerInput key={q.key} q={q} value={values[q.key]} onChange={(v) => setValues((s) => ({ ...s, [q.key]: v }))} />
                        ))}
                    </div>
                </fieldset>
            ))}
            {qs.length === 0 && <p className="aa-muted">No questions yet.</p>}
            <StepNote state={note} />
            <div className="aa-row">
                <button type="submit" className="aa-btn is-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save and continue'}</button>
            </div>
        </form>
    )
}

// ── Step 3: preferences ───────────────────────────────────────────
function ChipInput({ id, label, values, onChange, placeholder, hint }) {
    const [text, setText] = useState('')
    function add(raw) {
        const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
        if (!parts.length) return
        const set = new Set(values.map((v) => v.toLowerCase()))
        onChange([...values, ...parts.filter((p) => !set.has(p.toLowerCase()))])
        setText('')
    }
    return (
        <div className="aa-field">
            <label className="field-label" htmlFor={id}>{label}</label>
            <input
                id={id} className="input-field" value={text} placeholder={placeholder}
                onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value) : setText(e.target.value))}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(text) } }}
                onBlur={() => add(text)}
                aria-describedby={`${id}-hint`}
            />
            <div id={`${id}-hint`} className="field-hint">{hint || 'Press Enter or comma to add.'}</div>
            {values.length > 0 && (
                <div className="aa-chips" style={{ marginTop: 8 }}>
                    {values.map((v) => (
                        <span key={v} className="aa-chip">
                            {v}
                            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>×</button>
                        </span>
                    ))}
                </div>
            )}
        </div>
    )
}

function PrefsStep({ me, onNext }) {
    const save = useSaveProfile()
    const init = prefsJson(me)
    const [titles, setTitles] = useState(init.titles || [])
    const [locations, setLocations] = useState(init.locations || [])
    const [minScore, setMinScore] = useState(Number.isFinite(Number(init.min_score)) && init.min_score !== undefined ? Number(init.min_score) : 60)
    const [blocked, setBlocked] = useState(init.blocked_companies || [])
    const [employer, setEmployer] = useState(init.current_employer || '')
    const [note, setNote] = useState(null)

    function submit(e) {
        e.preventDefault()
        setNote(null)
        if (!titles.length) { setNote({ error: new Error('Add at least one job title.') }); return }
        save.mutate({
            prefs: { titles, locations, min_score: minScore, blocked_companies: blocked, current_employer: employer.trim() },
        }, {
            onSuccess: () => { setNote({ ok: 'Preferences saved.' }); onNext() },
            onError: (error) => setNote({ error }),
        })
    }

    return (
        <form className="aa-card aa-stack" onSubmit={submit} aria-labelledby="st-prefs" noValidate>
            <h2 id="st-prefs" className="aa-h2">Preferences</h2>
            <ChipInput id="pf-titles" label="Job titles" values={titles} onChange={setTitles} placeholder="e.g. Backend Engineer" />
            <ChipInput id="pf-locs" label="Locations" values={locations} onChange={setLocations} placeholder="e.g. Bengaluru, Remote India" />
            <div className="aa-field">
                <label className="field-label" htmlFor="pf-score">Minimum match score: <span style={{ color: 'var(--pop)' }}>{minScore}</span></label>
                <input id="pf-score" type="range" min={0} max={100} step={5} className="aa-range" value={minScore}
                    onChange={(e) => setMinScore(Number(e.target.value))} aria-valuetext={`${minScore} out of 100`} />
                <div className="field-hint">Higher means fewer, closer matches. Lower means more applications.</div>
            </div>
            <ChipInput id="pf-blocked" label="Blocked companies" values={blocked} onChange={setBlocked} placeholder="Companies we should never apply to" />
            <div className="aa-field">
                <label className="field-label" htmlFor="pf-employer">Current employer</label>
                <input id="pf-employer" className="input-field" value={employer} onChange={(e) => setEmployer(e.target.value)} placeholder="We never apply to your current employer" />
            </div>
            <StepNote state={note} />
            <div className="aa-row">
                <button type="submit" className="aa-btn is-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save and continue'}</button>
            </div>
        </form>
    )
}

// ── Step 4: email ─────────────────────────────────────────────────
function EmailStep({ me, onNext }) {
    const save = useSaveProfile()
    const email = me?.email || {}
    const prefs = me?.alert_prefs || { email: true, push: true }
    const [contact, setContact] = useState(email.contact_email || '')
    const [alertEmail, setAlertEmail] = useState(prefs.email !== false)
    const [note, setNote] = useState(null)
    const address = email.address || (email.alias ? `${email.alias}@apply.vloombox.in` : '')

    function submit(e) {
        e.preventDefault()
        setNote(null)
        if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) { setNote({ error: new Error('Enter a valid email address.') }); return }
        save.mutate({ email_mode: 'inbox', contact_email: contact.trim() || null, alert_prefs: { email: alertEmail } }, {
            onSuccess: () => { setNote({ ok: 'Email settings saved.' }); onNext() },
            onError: (error) => setNote({ error }),
        })
    }

    return (
        <form className="aa-card aa-stack" onSubmit={submit} aria-labelledby="st-email" noValidate>
            <h2 id="st-email" className="aa-h2">Email</h2>
            <p className="aa-muted" style={{ margin: 0 }}>
                Companies will email your Vloombox address{address ? <> <strong style={{ overflowWrap: 'anywhere' }}>{address}</strong></> : ''}.
                Everything shows up in your Vloombox inbox, and we will alert you about assessments and interviews so you do not miss them.
                We never forward your mail.
            </p>

            <div className="aa-field">
                <span className="field-label">Your Vloombox address</span>
                {address ? (
                    <div className="aa-row">
                        <code className="aa-code" style={{ flex: 1, minWidth: 200 }}>{address}</code>
                        <CopyButton text={address} label="Copy address" />
                    </div>
                ) : (
                    <p className="aa-faint" style={{ margin: 0 }}>Your address is created when you save your profile for the first time.</p>
                )}
            </div>

            <div className="aa-field">
                <label className="field-label" htmlFor="em-contact">Send alerts to</label>
                <input id="em-contact" type="email" className="input-field" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="you@example.com" autoComplete="email" />
                <div className="field-hint">A short email once a day when you have new assessments or interviews. It never contains the message itself; it links to your Vloombox inbox.</div>
                <label className="aa-row" style={{ gap: 8, marginTop: 8 }}>
                    <input type="checkbox" checked={alertEmail} onChange={(e) => setAlertEmail(e.target.checked)} />
                    <span className="aa-muted">Email me a daily alert</span>
                </label>
            </div>

            <div className="aa-field">
                <span className="field-label">Instant alerts</span>
                <NotifyButton />
                <div className="field-hint">Get a notification on this device the moment an important message arrives.</div>
            </div>

            <StepNote state={note} />
            <div className="aa-row">
                <button type="submit" className="aa-btn is-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save and continue'}</button>
            </div>
        </form>
    )
}

// ── Step 5: review + consent ──────────────────────────────────────
function ConsentStep({ me }) {
    const save = useSaveProfile()
    const navigate = useNavigate()
    const [review, setReview] = useState(me?.review_before_apply ?? true)
    const [consent, setConsent] = useState(false)
    const [note, setNote] = useState(null)
    const hours = me?.config?.review_hours ?? 6

    function finish(e) {
        e.preventDefault()
        setNote(null)
        if (!consent) { setNote({ error: new Error('Tick the consent box to continue.') }); return }
        save.mutate({ review_before_apply: review, consent: true, onboarding_done: true }, {
            onSuccess: () => navigate('/autoapply/buy'),
            onError: (error) => setNote({ error }),
        })
    }

    return (
        <form className="aa-card aa-stack" onSubmit={finish} aria-labelledby="st-consent" noValidate>
            <h2 id="st-consent" className="aa-h2">Confirm</h2>
            <label className="aa-check">
                <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
                <span>
                    <strong style={{ color: 'var(--bright)' }}>Let me review the shortlist before applying.</strong><br />
                    You get {hours} hours to remove jobs or approve early. After that we start applying.
                </span>
            </label>
            <label className="aa-check">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} required aria-required="true" />
                <span>
                    I agree that Vloombox submits job applications on my behalf using my profile, resume and answers, and creates
                    accounts on company career sites where needed. I can pause anytime.
                </span>
            </label>
            {me?.consent_at || me?.profile?.consent_at ? <p className="aa-faint" style={{ margin: 0 }}>You gave consent earlier; ticking again confirms it.</p> : null}
            <StepNote state={note} />
            <div className="aa-row">
                <button type="submit" className="aa-btn is-primary" disabled={save.isPending || !consent}>{save.isPending ? 'Saving…' : 'Finish setup'}</button>
            </div>
        </form>
    )
}

export default function SetupPage() {
    const me = useAutoApplyMe()
    const [params, setParams] = useSearchParams()
    const stepId = STEPS.some((s) => s.id === params.get('step')) ? params.get('step') : 'resume'
    const idx = STEPS.findIndex((s) => s.id === stepId)
    const [draft, setDraft] = useState(null)

    useEffect(() => {
        if (me.data && draft === null) {
            const p = profileJson(me.data)
            setDraft(Object.keys(p).length ? p : {})
        }
    }, [me.data, draft])

    const go = (id) => setParams({ step: id }, { replace: false })
    const next = () => { if (idx < STEPS.length - 1) go(STEPS[idx + 1].id) }

    return (
        <AALayout gate>
            <PageHeader eyebrow="AutoApply setup" title="Set up AutoApply" lead="About five minutes. You can change any of this later." />
            <ol className="aa-steps" aria-label="Setup steps">
                {STEPS.map((s, i) => (
                    <li key={s.id}>
                        <button type="button" aria-current={s.id === stepId ? 'step' : undefined} onClick={() => go(s.id)}>
                            <span className="aa-step-n">{i + 1}</span>{s.label}
                        </button>
                    </li>
                ))}
            </ol>
            {me.data && (
                <>
                    {stepId === 'resume' && <ResumeStep me={me.data} onNext={next} draft={draft || {}} setDraft={setDraft} />}
                    {stepId === 'answers' && <AnswersStep onNext={next} draft={draft} />}
                    {stepId === 'prefs' && <PrefsStep key="prefs" me={me.data} onNext={next} />}
                    {stepId === 'email' && <EmailStep key="email" me={me.data} onNext={next} />}
                    {stepId === 'consent' && <ConsentStep me={me.data} />}
                </>
            )}
        </AALayout>
    )
}

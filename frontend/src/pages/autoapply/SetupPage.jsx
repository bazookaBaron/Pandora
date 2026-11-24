import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
    Briefcase, CheckCircle2, FileText, Globe2, GraduationCap, IdCard, Lock, Mail, MapPin, ShieldCheck, SlidersHorizontal, Users,
} from 'lucide-react'
import { ErrorState, LoadingState, errorText } from '../../components/shared/states'
import {
    useAnswers, useAutoApplyMe, useSaveAnswers, useSaveProfile, useUploadResume,
} from '../../lib/useAutoApply'
import { CopyButton, SectionHead } from './ui'
import NotifyButton from './NotifyButton'
import { toast } from '../../lib/toast'
import { ROLE_SUGGESTIONS } from '../../lib/roleSuggestions'
import {
    ANYWHERE_IN_INDIA, EMAIL_RE, GROUPS, LOCATION_OPTIONS, MAX_LOCATIONS, MAX_TITLES, MIN_SCORE_LEVELS, SCHEMA_BY_KEY, TITLE_OPTIONS,
    checkAnswer, isRequired, normalisePhone, scoreLevel, validateProfileDraft, validateSetupAnswers,
} from '../../../lib/autoapply/setupOptions.js'

// Errors render inline next to the step's button, so skip the global error toast.
const INLINE = { meta: { inlineError: true } }

const STEPS = [
    { id: 'resume', label: 'Resume' },
    { id: 'answers', label: 'Answers' },
    { id: 'prefs', label: 'Preferences' },
    { id: 'email', label: 'Email' },
    { id: 'consent', label: 'Confirm' },
]

const MAX_RESUME_BYTES = 5 * 1024 * 1024
const TEXT_MAX = 200

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
/** server 400s carry {error: {fields: {key: message}}} */
const serverFields = (err) => (err?.body?.error?.fields && typeof err.body.error.fields === 'object' ? err.body.error.fields : null)

function StepNote({ state }) {
    if (!state) return null
    if (state.error?.code === 'consent_required') {
        return (
            <div className="aa-note is-warn" role="alert">
                {errorText(state.error)} <Link to="/autoapply/account?step=consent" style={{ color: 'var(--pop)' }}>Go to the Confirm step</Link>
            </div>
        )
    }
    if (state.error) return <ErrorState compact message={errorText(state.error)} />
    return <div className="aa-note is-ok" role="status">{state.ok}</div>
}

function FieldError({ id, msg }) {
    return msg ? <div id={id} className="aa-err" role="alert">{msg}</div> : null
}

/** "N left" line beside a disabled Save button, so it is clear why it is disabled. */
function Remaining({ errors, labelOf, onJump }) {
    const keys = Object.keys(errors)
    if (!keys.length) return <span className="aa-faint" style={{ color: 'var(--aa-success)' }}><CheckCircle2 size={12} aria-hidden="true" style={{ verticalAlign: -2 }} /> All set</span>
    return (
        <span className="aa-faint" role="status">
            {keys.length} to fix · first: <button type="button" className="aa-btn" style={{ padding: '2px 8px', minHeight: 0 }} onClick={() => onJump(keys[0])}>{labelOf(keys[0])}</button>
        </span>
    )
}

// ── Step 1: resume ─────────────────────────────────────────────────
function DraftField({ k, value, onChange, errors }) {
    const id = `draft-${k}`
    const err = errors[k]
    if (Array.isArray(value) && value.every((v) => typeof v !== 'object' || v === null)) {
        return (
            <div className={`aa-field${err ? ' is-invalid' : ''}`}>
                <label className="field-label" htmlFor={id}>{labelize(k)}{k === 'skills' && <span className="aa-req" aria-hidden> *</span>} <span className="aa-faint">(comma separated)</span></label>
                <textarea id={id} className="input-field" rows={2} maxLength={4000} value={value.join(', ')} aria-invalid={!!err} aria-describedby={err ? `${id}-err` : undefined}
                    onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim().slice(0, 60)).filter(Boolean))} />
                <FieldError id={`${id}-err`} msg={err} />
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
                                {Object.entries(item || {}).filter(([, v]) => typeof v !== 'object' || v === null).map(([ik, iv]) => {
                                    const fe = errors[`${k}.${i}.${ik}`]
                                    const fid = `${id}-${i}-${ik}`
                                    return (
                                        <div key={ik} className={`aa-field${fe ? ' is-invalid' : ''}`}>
                                            <label className="field-label" htmlFor={fid}>
                                                {labelize(ik)}{k === 'experience' && (ik === 'title' || ik === 'company') && <span className="aa-req" aria-hidden> *</span>}
                                            </label>
                                            <input id={fid} className="input-field" value={iv ?? ''} maxLength={ik === 'description' ? 2000 : TEXT_MAX}
                                                aria-invalid={!!fe} aria-describedby={fe ? `${fid}-err` : undefined}
                                                onChange={(e) => {
                                                    const next = value.slice()
                                                    next[i] = { ...item, [ik]: e.target.value }
                                                    onChange(next)
                                                }} />
                                            <FieldError id={`${fid}-err`} msg={fe} />
                                        </div>
                                    )
                                })}
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
            <input id={id} className="input-field" value={value ?? ''} maxLength={TEXT_MAX} onChange={(e) => onChange(e.target.value)} />
        </div>
    )
}

function ResumeStep({ me, onNext, draft, setDraft }) {
    const upload = useUploadResume(INLINE)
    const save = useSaveProfile(INLINE)
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

    const entries = Object.entries(draft || {})
    // skills and every past job's title + company are what forms ask for; the worker reads them from here
    const withSkills = entries.length && draft.skills === undefined ? { ...draft, skills: [] } : draft
    const errors = entries.length ? validateProfileDraft(withSkills || {}, { strict: true }) : {}
    const shown = entries.length && draft.skills === undefined ? [...entries, ['skills', []]] : entries

    function saveDraft() {
        setNote(null)
        if (Object.keys(errors).length) return
        save.mutate({ profile: draft }, {
            // the step unmounts on onNext, so confirm with a toast, not a note
            onSuccess: () => { toast.success('Profile saved.'); onNext() },
            onError: (error) => setNote({ error }),
        })
    }

    return (
        <section className="aa-card aa-seg tone-active aa-stack" aria-labelledby="st-resume">
            <SectionHead id="st-resume" icon={FileText} tone="active" title="Resume"
                sub={`We read your resume to fill application forms. PDF or DOCX, up to 5 MB.${onFile ? ' A resume is already on file; upload again to replace it.' : ''}`} />
            <div className="aa-row">
                <label className="aa-btn is-primary" htmlFor="aa-resume-file" style={{ cursor: upload.isPending ? 'wait' : 'pointer' }}>
                    {upload.isPending ? 'Reading resume…' : onFile ? 'Replace resume' : 'Upload resume'}
                </label>
                <input id="aa-resume-file" ref={fileRef} type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    className="aa-sr" onChange={pick} disabled={upload.isPending} />
                {upload.isPending && <LoadingState compact label="" />}
            </div>
            {fileErr && <ErrorState compact message={fileErr} />}

            {shown.length > 0 && (
                <>
                    <div className="aa-note is-info">Check what we read and fix anything wrong. Every past job needs its title and company, and add your skills: application forms ask for both.</div>
                    <div className="aa-stack">
                        {shown.map(([k, v]) => (
                            <DraftField key={k} k={k} value={v} errors={errors} onChange={(nv) => setDraft({ ...draft, [k]: nv })} />
                        ))}
                    </div>
                </>
            )}
            <StepNote state={note} />
            <div className="aa-row">
                {entries.length > 0 ? (
                    <>
                        <button type="button" className="aa-btn is-primary" onClick={saveDraft} disabled={save.isPending || Object.keys(errors).length > 0}>
                            {save.isPending ? 'Saving…' : 'Save and continue'}
                        </button>
                        {Object.keys(errors).length > 0 && <span className="aa-faint" role="status">{Object.keys(errors).length} to fix above</span>}
                    </>
                ) : (
                    <button type="button" className="aa-btn" onClick={onNext} disabled={!onFile}>Continue</button>
                )}
            </div>
        </section>
    )
}

// ── Step 2: standard answers ───────────────────────────────────────
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const pad2 = (n) => String(n).padStart(2, '0')

// Date of birth as Day / Month / Year selects (forms ask for each separately). Stored as YYYY-MM-DD once complete.
function DmyInput({ id, value, onChange, invalid, describedBy }) {
    const [y0, m0, d0] = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-') : ['', '', '']
    const [parts, setParts] = useState({ d: d0, m: m0, y: y0 })
    useEffect(() => { if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) { const [y, m, d] = value.split('-'); setParts({ d, m, y }) } }, [value])
    const nowY = new Date().getFullYear()
    const years = Array.from({ length: 65 }, (_, i) => String(nowY - 16 - i))
    const set = (k) => (e) => {
        const next = { ...parts, [k]: e.target.value }
        setParts(next)
        onChange(next.d && next.m && next.y ? `${next.y}-${next.m}-${next.d}` : '')
    }
    const common = { className: 'input-field provider-select', 'aria-invalid': invalid, 'aria-describedby': describedBy }
    return (
        <div className="aa-dmy" role="group" aria-labelledby={`${id}-lab`}>
            <select id={id} {...common} aria-label="Day" value={parts.d} onChange={set('d')}>
                <option value="">Day</option>
                {Array.from({ length: 31 }, (_, i) => pad2(i + 1)).map((d) => <option key={d} value={d}>{Number(d)}</option>)}
            </select>
            <select {...common} aria-label="Month" value={parts.m} onChange={set('m')}>
                <option value="">Month</option>
                {MONTHS.map((m, i) => <option key={m} value={pad2(i + 1)}>{m}</option>)}
            </select>
            <select {...common} aria-label="Year" value={parts.y} onChange={set('y')}>
                <option value="">Year</option>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
        </div>
    )
}

function YesNo({ id, value, onChange, options, invalid, describedBy }) {
    return (
        <div className="aa-segmented" role="radiogroup" aria-labelledby={`${id}-lab`} aria-invalid={invalid} aria-describedby={describedBy} id={id}>
            {options.map((o) => (
                <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>
            ))}
        </div>
    )
}

function MultiPick({ id, value, onChange, options, max, joiner = ', ', describedBy }) {
    const picked = String(value || '').split(',').map((s) => s.trim()).filter(Boolean)
    const toggle = (v) => {
        const next = picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v]
        onChange(next.join(joiner))
    }
    return (
        <div className="aa-multi-opts" role="group" aria-labelledby={`${id}-lab`} aria-describedby={describedBy} id={id}>
            {options.map((o) => {
                const on = picked.includes(o.value)
                return (
                    <button key={o.value} type="button" className="aa-opt" aria-pressed={on} disabled={!on && max && picked.length >= max} onClick={() => toggle(o.value)}>
                        {o.label}
                    </button>
                )
            })}
        </div>
    )
}

function AnswerInput({ q, value, onChange, onBlur, error }) {
    const id = `ans-${q.key}`
    const req = isRequired(q, {}) || !!q.requiredIf
    const describedBy = [q.help && `${id}-help`, error && `${id}-err`].filter(Boolean).join(' ') || undefined
    const options = q.options || []
    let input
    if (q.type === 'yesno') {
        input = <YesNo id={id} value={value} onChange={(v) => { onChange(v); onBlur() }} options={options} invalid={!!error} describedBy={describedBy} />
    } else if (q.type === 'multiselect') {
        input = <MultiPick id={id} value={value} onChange={(v) => { onChange(v); onBlur() }} options={options} max={q.maxItems} joiner={q.joiner} describedBy={describedBy} />
    } else if (q.type === 'select') {
        input = (
            <select id={id} className="input-field provider-select" value={value ?? ''} onChange={(e) => { onChange(e.target.value); onBlur() }}
                aria-required={req} aria-invalid={!!error} aria-describedby={describedBy}>
                <option value="">Choose…</option>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
        )
    } else if (q.type === 'date' && q.widget === 'dmy') {
        input = <DmyInput id={id} value={value} onChange={(v) => { onChange(v); if (v) onBlur() }} invalid={!!error} describedBy={describedBy} />
    } else if (q.type === 'date') {
        input = <input id={id} className="input-field" type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} aria-invalid={!!error} aria-describedby={describedBy} />
    } else {
        const isPhone = q.key === 'fields.phone'
        const isUrl = /linkedin|github|website/.test(q.key)
        input = (
            <>
                <input id={id} className="input-field" value={value ?? ''} onChange={(e) => onChange(e.target.value)}
                    onBlur={() => { if (isPhone) { const p = normalisePhone(value); if (p) onChange(p) } onBlur() }}
                    type={isPhone ? 'tel' : isUrl ? 'url' : 'text'} inputMode={isPhone ? 'tel' : q.inputMode || undefined}
                    autoComplete={isPhone ? 'tel' : q.key === 'fields.first_name' ? 'given-name' : q.key === 'fields.last_name' ? 'family-name' : q.key === 'fields.postal_code' ? 'postal-code' : q.key === 'fields.address_line1' ? 'address-line1' : 'off'}
                    maxLength={isPhone ? 20 : q.max || TEXT_MAX} placeholder={q.placeholder}
                    list={q.suggest === 'titles' ? `${id}-list` : undefined}
                    aria-required={req} aria-invalid={!!error} aria-describedby={describedBy} />
                {q.suggest === 'titles' && <datalist id={`${id}-list`}>{ROLE_SUGGESTIONS.map((r) => <option key={r} value={r} />)}</datalist>}
            </>
        )
    }
    return (
        <div className={`aa-field${error ? ' is-invalid' : ''}`}>
            <span className="field-label" id={`${id}-lab`}>
                {q.type === 'yesno' || q.type === 'multiselect' || q.widget === 'dmy'
                    ? q.label
                    : <label htmlFor={id}>{q.label}</label>}
                {req && <span className="aa-req" aria-hidden> *</span>}
            </span>
            {input}
            {q.help && <div id={`${id}-help`} className="field-hint">{q.help}</div>}
            <FieldError id={`${id}-err`} msg={error} />
        </div>
    )
}

const GROUP_STYLE = {
    'About you': [IdCard, 'active'],
    'Contact and address': [MapPin, 'active'],
    'Work and pay': [Briefcase, 'active'],
    Education: [GraduationCap, 'active'],
    'Work authorisation': [Globe2, 'active'],
    'Common form questions': [ShieldCheck, 'active'],
    'Diversity (you may decline)': [Users, 'history'],
}

const firstOption = (q, raw) => {
    if (!raw) return ''
    const r = checkAnswer(q, raw)
    return r.ok ? r.value : ''
}

/** Pre-fill empty answers from the parsed resume draft and the question defaults. */
function seedAnswers(saved, draft, questions) {
    const base = { ...(saved || {}) }
    const d = draft || {}
    const setIf = (key, raw) => {
        const q = SCHEMA_BY_KEY.get(key)
        if (q && !base[key] && raw) { const v = firstOption(q, raw); if (v) base[key] = v }
    }
    if (d.name) {
        const parts = String(d.name).trim().split(/\s+/)
        setIf('fields.first_name', d.first_name || parts[0])
        setIf('fields.last_name', d.last_name || parts.slice(1).join(' '))
        setIf('fields.preferred_name', d.first_name || parts[0])
    }
    setIf('fields.phone', d.phone)
    setIf('fields.linkedin', d.linkedin)
    setIf('fields.github', d.github || d.website)
    const loc = String(d.location || d.city || '').split(',')[0].trim()
    setIf('fields.city', d.city || loc)
    setIf('fields.state', d.state)
    const job = (Array.isArray(d.experience) ? d.experience : []).find((e) => e && typeof e === 'object') || {}
    setIf('fields.current_company', d.current_company || job.company)
    setIf('fields.current_title', d.current_title || job.title)
    const ed = (Array.isArray(d.education) ? d.education : []).find((e) => e && typeof e === 'object') || {}
    setIf('fields.school', ed.school || ed.institution)
    setIf('facts.graduation_year', ed.end_year || ed.year)
    for (const q of questions) {
        if (!base[q.key] && q.default != null) base[q.key] = firstOption(SCHEMA_BY_KEY.get(q.key) || q, q.default)
    }
    return base
}

function AnswersStep({ onNext, draft }) {
    const answersQ = useAnswers()
    const save = useSaveAnswers(INLINE)
    const [params] = useSearchParams()
    const [values, setValues] = useState({})
    const [touched, setTouched] = useState({})
    const [serverErr, setServerErr] = useState({})
    const [note, setNote] = useState(null)
    const seeded = useRef(false)
    const questions = useMemo(() => (answersQ.data?.questions || []).filter((q) => SCHEMA_BY_KEY.has(q.key)), [answersQ.data])

    useEffect(() => {
        if (!answersQ.data || seeded.current) return
        seeded.current = true
        setValues(seedAnswers(answersQ.data.answers, draft, questions))
    }, [answersQ.data, draft, questions])

    // ?field=fields.phone (from a "Fix" link) scrolls to that question
    const focusField = params.get('field')
    useEffect(() => {
        if (!focusField || !questions.length) return
        const el = document.getElementById(`ans-${focusField}`)
        if (el) { el.scrollIntoView({ block: 'center' }); el.focus?.() }
    }, [focusField, questions.length])

    const { values: clean, errors } = useMemo(() => validateSetupAnswers(values), [values])

    if (answersQ.isLoading) return <LoadingState label="Loading questions…" />
    if (answersQ.isError) return <ErrorState err={answersQ.error} onRetry={() => answersQ.refetch()} title="Could not load questions" />

    const shownErr = (k) => serverErr[k] || (touched[k] || touched.__all ? errors[k] : null)
    const labelOf = (k) => SCHEMA_BY_KEY.get(k)?.label || k
    const jump = (k) => {
        setTouched((t) => ({ ...t, [k]: true }))
        const el = document.getElementById(`ans-${k}`)
        if (el) { el.scrollIntoView({ block: 'center' }); el.focus?.() }
    }
    const invalid = Object.keys(errors).length > 0

    function submit(e) {
        e.preventDefault()
        setNote(null)
        setTouched((t) => ({ ...t, __all: true }))
        if (invalid) return
        const out = {}
        for (const q of questions) out[q.key] = clean[q.key] ?? ''
        save.mutate(out, {
            onSuccess: () => { toast.success('Answers saved.'); onNext() },
            onError: (error) => { setServerErr(serverFields(error) || {}); setNote({ error }) },
        })
    }

    return (
        <form className="aa-card aa-seg tone-active aa-stack" onSubmit={submit} aria-labelledby="st-answers" noValidate>
            <SectionHead id="st-answers" icon={IdCard} tone="active" title="Standard answers"
                sub="These answer the questions application forms ask. Every question is required so we never get stuck mid-application; pick from the lists, they match what forms expect." />
            {GROUPS.map((g) => {
                const list = questions.filter((q) => q.group === g)
                if (!list.length) return null
                const [Icon, tone] = GROUP_STYLE[g] || [IdCard, 'active']
                const done = list.filter((q) => clean[q.key] && !errors[q.key]).length
                return (
                    <fieldset key={g} className={`aa-fs tone-${tone}`}>
                        <legend><Icon size={14} aria-hidden="true" />{g} <span className="aa-fs-progress">{done}/{list.length}</span></legend>
                        <div className="aa-grid-2">
                            {list.map((q) => (
                                <AnswerInput key={q.key} q={q} value={values[q.key]} error={shownErr(q.key)}
                                    onChange={(v) => { setValues((s) => ({ ...s, [q.key]: v })); if (serverErr[q.key]) setServerErr((s) => ({ ...s, [q.key]: null })) }}
                                    onBlur={() => setTouched((t) => ({ ...t, [q.key]: true }))} />
                            ))}
                        </div>
                    </fieldset>
                )
            })}
            {questions.length === 0 && <p className="aa-muted">No questions yet.</p>}
            <StepNote state={note} />
            <div className="aa-row">
                <button type="submit" className="aa-btn is-primary" disabled={save.isPending || invalid}>{save.isPending ? 'Saving…' : 'Save and continue'}</button>
                <Remaining errors={errors} labelOf={labelOf} onJump={jump} />
            </div>
        </form>
    )
}

// ── Step 3: preferences ───────────────────────────────────────────
function TitlePicker({ values, onChange }) {
    const [text, setText] = useState('')
    const needle = text.trim().toLowerCase()
    const matches = TITLE_OPTIONS.filter((o) => !values.includes(o.value) && (!needle || o.label.toLowerCase().includes(needle))).slice(0, needle ? 30 : 18)
    const full = values.length >= MAX_TITLES
    return (
        <div className="aa-field">
            <label className="field-label" htmlFor="pf-titles">Job titles<span className="aa-req" aria-hidden> *</span> <span className="aa-faint">({values.length}/{MAX_TITLES})</span></label>
            {values.length > 0 && (
                <div className="aa-chips" style={{ marginBottom: 8 }} aria-label="Chosen job titles">
                    {values.map((v) => (
                        <span key={v} className="aa-chip">{v}<button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>×</button></span>
                    ))}
                </div>
            )}
            <input id="pf-titles" type="search" className="input-field" value={text} maxLength={60} autoComplete="off" disabled={full}
                placeholder={full ? `Up to ${MAX_TITLES} titles` : 'Search roles, e.g. backend, analyst, product'} onChange={(e) => setText(e.target.value)}
                aria-describedby="pf-titles-hint" aria-controls="pf-titles-opts" />
            <div id="pf-titles-hint" className="field-hint">Pick up to {MAX_TITLES}. We also match everyday variants (e.g. Software Engineer takes SDE, Developer).</div>
            {!full && (
                <div id="pf-titles-opts" className="aa-multi-opts" role="group" aria-label="Matching roles" style={{ marginTop: 8 }}>
                    {matches.map((o) => (
                        <button key={o.value} type="button" className="aa-opt" aria-pressed="false" onClick={() => { onChange([...values, o.value]); setText('') }}>+ {o.label}</button>
                    ))}
                    {matches.length === 0 && <span className="aa-faint">No role matches “{text.trim()}”. Try a shorter word.</span>}
                </div>
            )}
        </div>
    )
}

function LocationPicker({ values, onChange }) {
    const toggle = (v) => onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v])
    return (
        <div className="aa-field">
            <span className="field-label" id="pf-locs-lab">Locations<span className="aa-req" aria-hidden> *</span> <span className="aa-faint">({values.length}/{MAX_LOCATIONS})</span></span>
            <div className="aa-multi-opts" role="group" aria-labelledby="pf-locs-lab" aria-describedby="pf-locs-hint">
                {LOCATION_OPTIONS.map((o) => {
                    const on = values.includes(o.value)
                    return <button key={o.value} type="button" className="aa-opt" aria-pressed={on} disabled={!on && values.length >= MAX_LOCATIONS} onClick={() => toggle(o.value)}>{o.label}</button>
                })}
            </div>
            <div id="pf-locs-hint" className="field-hint">More locations means more matching jobs. &ldquo;Anywhere in India&rdquo; matches every city.</div>
        </div>
    )
}

function ChipInput({ id, label, values, onChange, placeholder, hint, max = 50 }) {
    const [text, setText] = useState('')
    function add(raw) {
        const parts = raw.split(',').map((s) => s.replace(/[<>]/g, '').trim().slice(0, 80)).filter(Boolean)
        if (!parts.length) return
        const set = new Set(values.map((v) => v.toLowerCase()))
        onChange([...values, ...parts.filter((p) => !set.has(p.toLowerCase()))].slice(0, max))
        setText('')
    }
    return (
        <div className="aa-field">
            <label className="field-label" htmlFor={id}>{label}</label>
            <input
                id={id} className="input-field" value={text} placeholder={placeholder} maxLength={80}
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

// saved prefs may hold values from the old free-text inputs: keep only list values (canonical casing)
const keepListed = (list, options) => (Array.isArray(list) ? list : [])
    .map((v) => options.find((o) => o.value.toLowerCase() === String(v).toLowerCase() || o.label.toLowerCase() === String(v).toLowerCase())?.value)
    .filter((v, i, a) => v && a.indexOf(v) === i)

/** default location suggestion: the resume's city (when it is in the list) + Anywhere in India */
function suggestLocations(me) {
    const p = profileJson(me)
    const city = String(p.city || p.location || '').split(',')[0].trim()
    const hit = keepListed([city], LOCATION_OPTIONS)
    return [...hit, ANYWHERE_IN_INDIA].filter((v, i, a) => a.indexOf(v) === i)
}

function prefsState(p, me) {
    const titles = keepListed(p.titles, TITLE_OPTIONS).slice(0, MAX_TITLES)
    const locs = keepListed(p.locations, LOCATION_OPTIONS)
    return {
        titles,
        locations: locs.length ? locs : suggestLocations(me),
        minScore: p.min_score === undefined ? 20 : scoreLevel(p.min_score),
        blocked: Array.isArray(p.blocked_companies) ? p.blocked_companies : [],
        employer: p.current_employer || '',
    }
}

function PrefsStep({ me, onNext }) {
    const save = useSaveProfile(INLINE)
    const [st, setSt] = useState(() => prefsState(prefsJson(me), me))
    const [note, setNote] = useState(null)
    const [serverErr, setServerErr] = useState({})
    // Until the user edits, follow /me: the cached copy may be stale on mount and a background refetch brings the saved values.
    const dirty = useRef(false)
    const edit = (k) => (v) => { dirty.current = true; setSt((s) => ({ ...s, [k]: v })) }
    const prefsKey = JSON.stringify(prefsJson(me))
    useEffect(() => {
        if (dirty.current) return
        setSt(prefsState(JSON.parse(prefsKey), me))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [prefsKey])

    const employer = st.employer.trim()
    const errors = {}
    if (!st.titles.length) errors.titles = 'Pick at least one job title.'
    if (!st.locations.length) errors.locations = 'Pick at least one location.'
    if (employer.length < 2) errors.employer = 'Enter your current or last employer (we never apply there).'
    else if (employer.length > 80 || /[<>]/.test(employer)) errors.employer = 'At most 80 characters, no < or >.'
    const invalid = Object.keys(errors).length > 0

    function submit(e) {
        e.preventDefault()
        setNote(null)
        if (invalid) return
        save.mutate({
            prefs: { titles: st.titles, locations: st.locations, min_score: st.minScore, blocked_companies: st.blocked, current_employer: employer },
        }, {
            onSuccess: () => { toast.success('Preferences saved.'); onNext() },
            onError: (error) => { setServerErr(serverFields(error) || {}); setNote({ error }) },
        })
    }
    const err = (k) => serverErr[`prefs.${k}`] || (dirty.current ? errors[k] : null)

    return (
        <form className="aa-card aa-seg tone-active aa-stack" onSubmit={submit} aria-labelledby="st-prefs" noValidate>
            <SectionHead id="st-prefs" icon={SlidersHorizontal} tone="active" title="Preferences" sub="What we look for. Everything here is picked from lists, so it matches how jobs are posted." />
            <fieldset className="aa-fs tone-active">
                <legend><Briefcase size={14} aria-hidden="true" />Roles</legend>
                <TitlePicker values={st.titles} onChange={edit('titles')} />
                <FieldError id="pf-titles-err" msg={err('titles')} />
            </fieldset>
            <fieldset className="aa-fs tone-active">
                <legend><MapPin size={14} aria-hidden="true" />Where</legend>
                <LocationPicker values={st.locations} onChange={edit('locations')} />
                <FieldError id="pf-locs-err" msg={err('locations')} />
            </fieldset>
            <fieldset className="aa-fs tone-active">
                <legend><SlidersHorizontal size={14} aria-hidden="true" />How close a match</legend>
                <div className="aa-score-opts" role="radiogroup" aria-label="How close a match">
                    {MIN_SCORE_LEVELS.map((l) => (
                        <button key={l.value} type="button" role="radio" aria-checked={st.minScore === l.value} className="aa-choice" onClick={() => edit('minScore')(l.value)}>
                            <span className="aa-choice-title">{l.label}</span>
                            <span className="aa-muted">{l.help}</span>
                        </button>
                    ))}
                </div>
                <div className="field-hint" style={{ marginTop: 8 }}>Jobs without a description are always judged on title and location only.</div>
            </fieldset>
            <fieldset className="aa-fs tone-history">
                <legend><Lock size={14} aria-hidden="true" />Never apply to</legend>
                <div className="aa-grid-2">
                    <div className={`aa-field${err('employer') ? ' is-invalid' : ''}`}>
                        <label className="field-label" htmlFor="pf-employer">Current or last employer<span className="aa-req" aria-hidden> *</span></label>
                        <input id="pf-employer" className="input-field" value={st.employer} maxLength={80} onChange={(e) => edit('employer')(e.target.value)}
                            placeholder="e.g. Infosys" aria-invalid={!!err('employer')} aria-describedby="pf-employer-err" />
                        <FieldError id="pf-employer-err" msg={err('employer')} />
                    </div>
                    <ChipInput id="pf-blocked" label="Other blocked companies (optional)" values={st.blocked} onChange={edit('blocked')} placeholder="Company name" hint="Press Enter or comma to add. Up to 50." />
                </div>
            </fieldset>
            <StepNote state={note} />
            <div className="aa-row">
                <button type="submit" className="aa-btn is-primary" disabled={save.isPending || invalid}>{save.isPending ? 'Saving…' : 'Save and continue'}</button>
                {invalid && <span className="aa-faint" role="status">{Object.values(errors)[0]}</span>}
            </div>
        </form>
    )
}

// ── Step 4: email ─────────────────────────────────────────────────
function EmailStep({ me, onNext }) {
    const save = useSaveProfile(INLINE)
    const email = me?.email || {}
    const prefs = me?.alert_prefs || { email: true, push: true }
    const [contact, setContactRaw] = useState(email.contact_email || '')
    const [alertEmail, setAlertEmailRaw] = useState(prefs.email !== false)
    const [touched, setTouched] = useState(false)
    const [note, setNote] = useState(null)
    const dirty = useRef(false)
    const setContact = (v) => { dirty.current = true; setContactRaw(v) }
    const setAlertEmail = (v) => { dirty.current = true; setAlertEmailRaw(v) }
    const freshContact = email.contact_email || ''
    const freshAlert = prefs.email !== false
    useEffect(() => {
        if (dirty.current) return
        setContactRaw(freshContact)
        setAlertEmailRaw(freshAlert)
    }, [freshContact, freshAlert])
    const address = email.address || (email.alias ? `${email.alias}@apply.vloombox.in` : '')
    const value = contact.trim()
    const error = !value ? 'Enter the email address we should alert.' : value.length > 254 || !EMAIL_RE.test(value) ? 'Enter a valid email address, e.g. you@gmail.com.' : null

    function submit(e) {
        e.preventDefault()
        setNote(null)
        setTouched(true)
        if (error) return
        save.mutate({ email_mode: 'inbox', contact_email: value, alert_prefs: { email: alertEmail } }, {
            onSuccess: () => { toast.success('Email settings saved.'); onNext() },
            onError: (err) => setNote({ error: err }),
        })
    }

    return (
        <form className="aa-card aa-seg tone-active aa-stack" onSubmit={submit} aria-labelledby="st-email" noValidate>
            <SectionHead id="st-email" icon={Mail} tone="active" title="Email"
                sub="Companies email your Vloombox address. Everything shows up in your Vloombox inbox, and we alert you about assessments and interviews. We never forward your mail." />

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

            <div className={`aa-field${touched && error ? ' is-invalid' : ''}`}>
                <label className="field-label" htmlFor="em-contact">Send alerts to<span className="aa-req" aria-hidden> *</span></label>
                <input id="em-contact" type="email" className="input-field" value={contact} maxLength={254} onChange={(e) => setContact(e.target.value)} onBlur={() => setTouched(true)}
                    placeholder="you@example.com" autoComplete="email" aria-required="true" aria-invalid={!!(touched && error)} aria-describedby="em-contact-hint em-contact-err" />
                <div id="em-contact-hint" className="field-hint">A short email once a day when you have new assessments or interviews. It never contains the message itself; it links to your Vloombox inbox.</div>
                <FieldError id="em-contact-err" msg={touched ? error : null} />
            </div>
            <div className="aa-field">
                <span className="field-label" id="em-alert-lab">Daily email alert</span>
                <div className="aa-segmented" role="radiogroup" aria-labelledby="em-alert-lab">
                    <button type="button" role="radio" aria-checked={alertEmail} onClick={() => setAlertEmail(true)}>On</button>
                    <button type="button" role="radio" aria-checked={!alertEmail} onClick={() => setAlertEmail(false)}>Off</button>
                </div>
            </div>

            <div className="aa-field">
                <span className="field-label">Instant alerts</span>
                <NotifyButton />
                <div className="field-hint">Get a notification on this device the moment an important message arrives.</div>
            </div>

            <StepNote state={note} />
            <div className="aa-row">
                <button type="submit" className="aa-btn is-primary" disabled={save.isPending || !!error}>{save.isPending ? 'Saving…' : 'Save and continue'}</button>
                {error && <span className="aa-faint" role="status">{error}</span>}
            </div>
        </form>
    )
}

// ── Step 5: review + consent ──────────────────────────────────────
function ConsentStep({ me }) {
    const save = useSaveProfile(INLINE)
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
            onSuccess: () => { toast.success('Setup complete.'); navigate('/autoapply/buy') },
            onError: (error) => setNote({ error }),
        })
    }

    return (
        <form className="aa-card aa-seg tone-success aa-stack" onSubmit={finish} aria-labelledby="st-consent" noValidate>
            <SectionHead id="st-consent" icon={ShieldCheck} tone="success" title="Confirm" />
            <label className="aa-check">
                <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
                <span>
                    <strong style={{ color: 'var(--bright)' }}>Let me review the shortlist before applying.</strong><br />
                    You get {hours} hours to approve early. After that we start applying.
                </span>
            </label>
            <label className="aa-check">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} required aria-required="true" />
                <span>
                    I agree that Vloombox submits job applications on my behalf using my profile, resume and answers, and creates
                    accounts on company career sites where needed. I can pause anytime.<span className="aa-req" aria-hidden> *</span>
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

export default function SetupSection({ initialStep = null }) {
    const me = useAutoApplyMe()
    const [params, setParams] = useSearchParams()
    const wanted = params.get('step') || initialStep
    const stepId = STEPS.some((s) => s.id === wanted) ? wanted : 'resume'
    const idx = STEPS.findIndex((s) => s.id === stepId)
    const [draft, setDraft] = useState(null)

    useEffect(() => {
        if (me.data && draft === null) {
            const p = profileJson(me.data)
            setDraft(Object.keys(p).length ? p : {})
        }
    }, [me.data, draft])

    // Which steps are complete (server state), so later steps stay locked until the previous one is done.
    const m = me.data || {}
    const prof = profileJson(m)
    const missing = (m.readiness?.missing || m.profile_check?.missing || []).map((x) => (x && typeof x === 'object' ? x.key : String(x || '')))
    const NON_ANSWER = new Set(['onboarding', 'resume', 'email', 'prefs', 'titles', 'consent'])
    const resumeDone = !!(m.resume_path || prof.resume_path) && !missing.includes('resume')
    const done = {
        resume: resumeDone,
        answers: resumeDone && !missing.some((k) => !NON_ANSWER.has(k)),
        prefs: Array.isArray(m.prefs?.titles) && m.prefs.titles.length > 0,
        email: !missing.includes('email') && !!(m.prefs || m.consent_at || m.onboarding_done || m.email || m.portal_email),
        consent: !!(m.consent_at && m.onboarding_done),
    }
    const [reached, setReached] = useState(0)          // steps opened with Continue in this visit stay open
    const unlocked = (i) => i === 0 || i <= reached || STEPS.slice(0, i).every((s) => done[s.id])
    const go = (id) => {
        const i = STEPS.findIndex((s) => s.id === id)
        if (i >= 0 && unlocked(i)) setParams({ step: id }, { replace: false })
    }
    const next = () => {
        if (idx < STEPS.length - 1) {
            setReached((r) => Math.max(r, idx + 1))
            setParams({ step: STEPS[idx + 1].id }, { replace: false })
        }
    }
    // a deep link to a locked step falls back to the first unfinished one
    useEffect(() => {
        if (me.data && !unlocked(idx)) {
            const first = STEPS.findIndex((s) => !done[s.id])
            setParams({ step: STEPS[Math.max(0, first)].id }, { replace: true })
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [me.data, idx])
    const allDone = STEPS.every((s) => done[s.id])

    return (
        <div>
            {!allDone && (
                <p className="aa-setup-intro">
                    Fill in these details once and we&apos;ll start applying for you. Each step unlocks when the one before it is done.
                </p>
            )}
            <ol className="aa-setup-pipe" aria-label="Setup steps">
                {STEPS.map((s, i) => {
                    const open = unlocked(i)
                    const state = s.id === stepId ? 'current' : done[s.id] ? 'done' : open ? 'open' : 'locked'
                    return (
                        <li key={s.id} className={`aa-setup-step is-${state}`}>
                            <button type="button" disabled={!open} aria-current={s.id === stepId ? 'step' : undefined}
                                title={open ? s.label : 'Finish the previous step first'} onClick={() => go(s.id)}>
                                <span className="aa-setup-dot" aria-hidden="true">{state === 'done' ? '✓' : state === 'locked' ? <Lock size={11} /> : i + 1}</span>
                                <span className="aa-setup-label">{s.label}{state === 'locked' && <span className="aa-sr"> (locked)</span>}</span>
                            </button>
                        </li>
                    )
                })}
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
        </div>
    )
}

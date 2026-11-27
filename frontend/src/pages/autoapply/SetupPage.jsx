import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { CheckCircle2 } from 'lucide-react'
import { ErrorState, LoadingState, errorText } from '../../components/shared/states'
import { Row, Stepper } from '../../components/ui'
import { track, TRACK } from '../../lib/track'
import {
    useAnswers, useAutoApplyMe, useSaveAnswers, useSaveProfile, useUploadResume,
} from '../../lib/useAutoApply'
import { CopyButton, SETUP_LABELS, SETUP_ORDER, writeSetupStep } from './ui'
import NotifyButton from './NotifyButton'
import { toast } from '../../lib/toast'
import { ROLE_SUGGESTIONS } from '../../lib/roleSuggestions'
import {
    ANYWHERE_IN_INDIA, EMAIL_RE, GROUPS, LOCATION_OPTIONS, MAX_LOCATIONS, MAX_TITLES, MIN_SCORE_LEVELS, SCHEMA_BY_KEY, TITLE_OPTIONS,
    checkAnswer, isRequired, normalisePhone, scoreLevel, validateProfileDraft, validateSetupAnswers,
} from '../../../lib/autoapply/setupOptions.js'

// Setup = one Stepper, 5 screens: Role & experience -> Location -> Resume -> Common questions -> Review.
// Every Continue saves to the server (PUT /profile, /answers), so progress survives leaving; the step id is
// also remembered on this device (ui.jsx readSetupStep) for the "Continue setup" button on the Auto Apply home.

// Errors render inline in the stepper, so skip the global error toast.
const INLINE = { meta: { inlineError: true } }
const TOTAL = SETUP_ORDER.length
// old step ids (deep links, guide CTAs, server "fix" links) -> new ones
const STEP_ALIAS = { prefs: 'role', email: 'review', consent: 'review' }
const stepNo = (id) => SETUP_ORDER.indexOf(id) + 1

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

function FieldError({ id, msg }) {
    return msg ? <div id={id} className="aa-err" role="alert">{msg}</div> : null
}

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
                onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }}
                aria-describedby="pf-titles-hint" aria-controls="pf-titles-opts" />
            <div id="pf-titles-hint" className="field-hint">Up to {MAX_TITLES}. Variants (SDE, Developer) are included.</div>
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
            <div id="pf-locs-hint" className="field-hint">&ldquo;Anywhere in India&rdquo; matches every city.</div>
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
        minScore: p.min_score === undefined || p.min_score === null || p.min_score === "" ? 20 : scoreLevel(p.min_score),
        blocked: Array.isArray(p.blocked_companies) ? p.blocked_companies : [],
        employer: p.current_employer || '',
    }
}

const noteText = (e) => (e ? (e.code === 'consent_required' ? `${errorText(e)} Tick the consent box below.` : errorText(e)) : null)

// ── Steps 1 + 2: role and location (both write prefs; each Continue saves the whole prefs object) ──
function usePrefsForm(me) {
    const save = useSaveProfile(INLINE)
    const [st, setSt] = useState(() => prefsState(prefsJson(me), me))
    const [note, setNote] = useState(null)
    const [serverErr, setServerErr] = useState({})
    const [tried, setTried] = useState(false)
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
    if (employer.length < 2) errors.employer = 'Enter your current or last employer. We never apply there.'
    else if (employer.length > 80 || /[<>]/.test(employer)) errors.employer = 'At most 80 characters, no < or >.'

    function submit(keys, onDone) {
        setNote(null)
        setTried(true)
        if (keys.some((k) => errors[k])) return
        save.mutate({
            prefs: { titles: st.titles, locations: st.locations, min_score: st.minScore, blocked_companies: st.blocked, current_employer: employer },
        }, {
            onSuccess: () => onDone(),
            onError: (error) => { setServerErr(serverFields(error) || {}); setNote(error) },
        })
    }
    const err = (k) => serverErr[`prefs.${k}`] || (dirty.current || tried ? errors[k] : null)
    const firstErr = (keys) => keys.map((k) => err(k)).find(Boolean) || null
    return { st, edit, err, firstErr, submit, busy: save.isPending, note }
}

function RoleStep({ me, onNext }) {
    const f = usePrefsForm(me)
    const keys = ['titles', 'employer']
    return (
        <Stepper step={stepNo('role')} total={TOTAL} title="What job do you want?" hint="Pick up to 5 roles."
            onNext={() => f.submit(keys, onNext)} busy={f.busy} error={noteText(f.note) || f.firstErr(keys)}>
            <div className="aa-stack" style={{ gap: 18 }}>
                <TitlePicker values={f.st.titles} onChange={f.edit('titles')} />
                <div className="aa-field">
                    <span className="field-label" id="pf-score-lab">How close a match</span>
                    <div className="aa-score-opts" role="radiogroup" aria-labelledby="pf-score-lab">
                        {MIN_SCORE_LEVELS.map((l) => (
                            <button key={l.value} type="button" role="radio" aria-checked={f.st.minScore === l.value} className="aa-choice" onClick={() => f.edit('minScore')(l.value)}>
                                <span className="aa-choice-title">{l.label}</span>
                                <span className="aa-muted">{l.help}</span>
                            </button>
                        ))}
                    </div>
                </div>
                <div className={`aa-field${f.err('employer') ? ' is-invalid' : ''}`}>
                    <label className="field-label" htmlFor="pf-employer">Current or last employer<span className="aa-req" aria-hidden> *</span></label>
                    <input id="pf-employer" className="input-field" value={f.st.employer} maxLength={80} onChange={(e) => f.edit('employer')(e.target.value)}
                        placeholder="e.g. Infosys" aria-invalid={!!f.err('employer')} aria-describedby="pf-employer-hint" />
                    <div id="pf-employer-hint" className="field-hint">We never apply here.</div>
                </div>
                <details className="aa-more">
                    <summary>Block other companies{f.st.blocked.length ? ` (${f.st.blocked.length})` : ''}</summary>
                    <ChipInput id="pf-blocked" label="Never apply to (optional)" values={f.st.blocked} onChange={f.edit('blocked')} placeholder="Company name" hint="Press Enter or comma to add. Up to 50." />
                </details>
            </div>
        </Stepper>
    )
}

function LocationStep({ me, onNext, onBack }) {
    const f = usePrefsForm(me)
    const keys = ['locations']
    return (
        <Stepper step={stepNo('location')} total={TOTAL} title="Where do you want to work?" hint="Pick up to 10 places."
            onBack={onBack} onNext={() => f.submit(keys, onNext)} busy={f.busy} error={noteText(f.note) || f.firstErr(keys)}>
            <LocationPicker values={f.st.locations} onChange={f.edit('locations')} />
        </Stepper>
    )
}

// ── Step 3: resume ─────────────────────────────────────────────────
function ResumeStep({ me, onNext, onBack, draft, setDraft }) {
    const upload = useUploadResume(INLINE)
    const save = useSaveProfile(INLINE)
    const [fileErr, setFileErr] = useState('')
    const [note, setNote] = useState(null)
    const [justRead, setJustRead] = useState(false)
    const onFile = me ? resumePath(me) : null

    function pick(e) {
        const f = e.target.files?.[0]
        setFileErr('')
        setNote(null)
        if (!f) return
        if (!/\.(pdf|docx)$/i.test(f.name)) { setFileErr('Upload a PDF or DOCX file.'); return }
        if (f.size > MAX_RESUME_BYTES) { setFileErr('That file is over 5 MB.'); return }
        upload.mutate(f, {
            onSuccess: (res) => { setDraft(res?.parsed || {}); setJustRead(true) },
            onError: (err) => setFileErr(errorText(err)),
        })
    }

    const entries = Object.entries(draft || {})
    // skills and every past job's title + company are what forms ask for; the worker reads them from here
    const withSkills = entries.length && draft.skills === undefined ? { ...draft, skills: [] } : draft
    const errors = entries.length ? validateProfileDraft(withSkills || {}, { strict: true }) : {}
    const shown = entries.length && draft.skills === undefined ? [...entries, ['skills', []]] : entries
    const nErr = Object.keys(errors).length

    function next() {
        setNote(null)
        if (!onFile && !entries.length) return
        if (!entries.length) { onNext(); return }
        if (nErr) return
        save.mutate({ profile: draft }, { onSuccess: () => onNext(), onError: (error) => setNote(error) })
    }

    const fixMsg = nErr ? `${nErr} item${nErr === 1 ? '' : 's'} to fix in what we read.` : null
    return (
        <Stepper step={stepNo('resume')} total={TOTAL} title="Add your resume" hint="PDF or DOCX, up to 5 MB."
            onBack={onBack} onNext={next} canNext={!!(onFile || entries.length) && !upload.isPending} busy={save.isPending}
            error={fileErr || noteText(note) || fixMsg}>
            <div className="aa-stack">
                <div className="aa-row">
                    <label className="aa-btn is-primary aa-upload" htmlFor="aa-resume-file" style={{ cursor: upload.isPending ? 'wait' : 'pointer' }}>
                        {upload.isPending ? 'Reading resume…' : onFile ? 'Replace resume' : 'Upload resume'}
                    </label>
                    <input id="aa-resume-file" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        className="aa-sr" onChange={pick} disabled={upload.isPending} />
                    {onFile && !upload.isPending && <span className="aa-ok-line"><CheckCircle2 size={16} aria-hidden="true" /> On file</span>}
                </div>
                {shown.length > 0 && (
                    <details className="aa-more" open={justRead || nErr > 0}>
                        <summary>Check what we read{nErr ? ` · ${nErr} to fix` : ''}</summary>
                        <div className="aa-stack" style={{ marginTop: 10 }}>
                            <p className="aa-muted" style={{ margin: 0 }}>Each job needs a title and company. Add your skills.</p>
                            {shown.map(([k, v]) => (
                                <DraftField key={k} k={k} value={v} errors={errors} onChange={(nv) => setDraft({ ...draft, [k]: nv })} />
                            ))}
                        </div>
                    </details>
                )}
            </div>
        </Stepper>
    )
}

// ── Step 4: common questions, one group per screen ──────────────────
function AnswersStep({ onNext, onBack, draft }) {
    const answersQ = useAnswers()
    const save = useSaveAnswers(INLINE)
    const [params] = useSearchParams()
    const [values, setValues] = useState(null)
    const [touched, setTouched] = useState({})
    const [serverErr, setServerErr] = useState({})
    const [note, setNote] = useState(null)
    const [g, setG] = useState(null)
    const questions = useMemo(() => (answersQ.data?.questions || []).filter((q) => SCHEMA_BY_KEY.has(q.key)), [answersQ.data])
    const groups = useMemo(() => GROUPS.map((name) => ({ name, list: questions.filter((q) => q.group === name) })).filter((x) => x.list.length), [questions])
    const { values: clean, errors } = useMemo(() => validateSetupAnswers(values || {}), [values])
    const focusField = params.get('field')

    // seed once, then open the group of ?field= (a "Fix" link), else the first group with something missing
    useEffect(() => {
        if (!answersQ.data || values !== null) return
        const seeded = seedAnswers(answersQ.data.answers, draft, questions)
        setValues(seeded)
        const { errors: e0 } = validateSetupAnswers(seeded)
        const byField = focusField ? groups.findIndex((x) => x.list.some((q) => q.key === focusField)) : -1
        const firstOpen = groups.findIndex((x) => x.list.some((q) => e0[q.key]))
        setG(byField >= 0 ? byField : Math.max(0, firstOpen))
    }, [answersQ.data, draft, questions, groups, values, focusField])
    useEffect(() => {
        if (!focusField || g === null) return
        const el = document.getElementById(`ans-${focusField}`)
        if (el) { el.scrollIntoView({ block: 'center' }); el.focus?.() }
    }, [focusField, g])

    if (answersQ.isLoading || (answersQ.data && values === null)) return <LoadingState label="Loading questions…" />
    if (answersQ.isError) return <ErrorState err={answersQ.error} onRetry={() => answersQ.refetch()} title="Could not load questions" />
    if (!groups.length) {
        return (
            <Stepper step={stepNo('answers')} total={TOTAL} title="Common questions" onBack={onBack} onNext={onNext}>
                <p className="aa-muted">No questions yet.</p>
            </Stepper>
        )
    }

    const gi = Math.min(g ?? 0, groups.length - 1)
    const group = groups[gi]
    const groupErr = group.list.filter((q) => errors[q.key])
    const tried = !!touched[`__g${gi}`]
    const shownErr = (k) => serverErr[k] || (touched[k] || tried ? errors[k] : null)
    const done = group.list.filter((q) => clean[q.key] && !errors[q.key]).length

    function next() {
        setNote(null)
        setTouched((t) => ({ ...t, [`__g${gi}`]: true }))
        if (groupErr.length) {
            const el = document.getElementById(`ans-${groupErr[0].key}`)
            if (el) { el.scrollIntoView({ block: 'center' }); el.focus?.() }
            return
        }
        const out = {}
        for (const q of group.list) if (clean[q.key]) out[q.key] = clean[q.key]
        const advance = () => {
            if (gi < groups.length - 1) { setG(gi + 1); window.scrollTo?.(0, 0) } else onNext()
        }
        if (!Object.keys(out).length) { advance(); return }
        save.mutate(out, {
            onSuccess: () => advance(),
            onError: (error) => { setServerErr(serverFields(error) || {}); setNote(error) },
        })
    }

    return (
        <Stepper step={stepNo('answers')} total={TOTAL} title={group.name}
            hint={`Common questions · part ${gi + 1} of ${groups.length} · ${done}/${group.list.length} done`}
            onBack={gi > 0 ? () => setG(gi - 1) : onBack} onNext={next} busy={save.isPending}
            error={noteText(note) || (tried && groupErr.length ? `${groupErr.length} to fix: ${groupErr[0].label}` : null)}>
            <div className="aa-stack" style={{ gap: 16 }}>
                {group.list.map((q) => (
                    <AnswerInput key={q.key} q={q} value={values[q.key]} error={shownErr(q.key)}
                        onChange={(v) => { setValues((s) => ({ ...s, [q.key]: v })); if (serverErr[q.key]) setServerErr((s) => ({ ...s, [q.key]: null })) }}
                        onBlur={() => setTouched((t) => ({ ...t, [q.key]: true }))} />
                ))}
            </div>
        </Stepper>
    )
}

// ── Step 5: review, email alerts, consent ───────────────────────────
function ReviewStep({ me, done, onBack, go }) {
    const save = useSaveProfile(INLINE)
    const navigate = useNavigate()
    const email = me?.email || {}
    const prefs = me?.alert_prefs || { email: true, push: true }
    const p = prefsJson(me)
    const [contact, setContact] = useState(email.contact_email || '')
    const [alertEmail, setAlertEmail] = useState(prefs.email !== false)
    const [review, setReview] = useState(me?.review_before_apply ?? true)
    const [consent, setConsent] = useState(false)
    const [tried, setTried] = useState(false)
    const [note, setNote] = useState(null)
    const hours = me?.config?.review_hours ?? 6
    const address = email.address || (email.alias ? `${email.alias}@apply.vloombox.in` : '')
    const value = contact.trim()
    const emailErr = !value ? 'Enter the email we should alert.' : value.length > 254 || !EMAIL_RE.test(value) ? 'Enter a valid email, e.g. you@gmail.com.' : null
    const openStep = SETUP_ORDER.slice(0, -1).find((id) => !done[id])

    function finish() {
        setNote(null)
        setTried(true)
        if (emailErr || !consent) return
        save.mutate({ email_mode: 'inbox', contact_email: value, alert_prefs: { email: alertEmail }, review_before_apply: review, consent: true, onboarding_done: true }, {
            onSuccess: () => { toast.success('Setup complete.'); writeSetupStep(null); navigate('/autoapply/buy') },
            onError: (error) => setNote(error),
        })
    }

    const list = (a) => (Array.isArray(a) && a.length ? a.join(', ') : 'Not set')
    const status = (id) => ({ meta: done[id] ? 'Done' : 'To do', metaTone: done[id] ? 'success' : 'attention', onClick: () => go(id) })
    const err = noteText(note)
        || (tried ? emailErr || (!consent ? 'Tick the consent box to finish.' : null) : null)
        || (openStep ? `${SETUP_LABELS[openStep]} is not finished yet.` : null)
    return (
        <Stepper step={stepNo('review')} total={TOTAL} title="Check and finish" hint="Tap a line to change it."
            onBack={onBack} onNext={finish} busy={save.isPending} nextLabel="Finish setup" error={err}>
            <div className="aa-stack" style={{ gap: 18 }}>
                <ul className="sys-rows">
                    <li><Row title={SETUP_LABELS.role} sub={list(p.titles)} {...status('role')} /></li>
                    <li><Row title={SETUP_LABELS.location} sub={list(p.locations)} {...status('location')} /></li>
                    <li><Row title={SETUP_LABELS.resume} sub={resumePath(me) ? 'On file' : 'Not added'} {...status('resume')} /></li>
                    <li><Row title={SETUP_LABELS.answers} {...status('answers')} /></li>
                </ul>

                <div className={`aa-field${tried && emailErr ? ' is-invalid' : ''}`}>
                    <label className="field-label" htmlFor="em-contact">Send alerts to<span className="aa-req" aria-hidden> *</span></label>
                    <input id="em-contact" type="email" className="input-field" value={contact} maxLength={254} onChange={(e) => setContact(e.target.value)}
                        placeholder="you@example.com" autoComplete="email" aria-required="true" aria-invalid={!!(tried && emailErr)} aria-describedby="em-contact-hint" />
                    <div id="em-contact-hint" className="field-hint">We email you when interviews or tests arrive.</div>
                </div>
                <div className="aa-field">
                    <span className="field-label" id="em-alert-lab">Daily email alert</span>
                    <div className="aa-segmented" role="radiogroup" aria-labelledby="em-alert-lab">
                        <button type="button" role="radio" aria-checked={alertEmail} onClick={() => setAlertEmail(true)}>On</button>
                        <button type="button" role="radio" aria-checked={!alertEmail} onClick={() => setAlertEmail(false)}>Off</button>
                    </div>
                </div>
                <details className="aa-more">
                    <summary>Your apply address and phone alerts</summary>
                    <div className="aa-stack" style={{ marginTop: 10 }}>
                        <p className="aa-muted" style={{ margin: 0 }}>Companies write to this address. Mail shows in your Inbox.</p>
                        {address ? (
                            <div className="aa-row">
                                <code className="aa-code" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{address}</code>
                                <CopyButton text={address} label="Copy" />
                            </div>
                        ) : <p className="aa-faint" style={{ margin: 0 }}>Made when you finish setup.</p>}
                        <NotifyButton />
                    </div>
                </details>

                <label className="aa-check">
                    <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
                    <span>Let me check the job list first. You get {hours} hours, then we apply.</span>
                </label>
                <label className="aa-check">
                    <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} required aria-required="true" />
                    <span>
                        I agree that Vloombox submits job applications on my behalf using my profile, resume and answers, and creates
                        accounts on company career sites where needed. I can pause anytime.<span className="aa-req" aria-hidden> *</span>
                    </span>
                </label>
                {me?.consent_at || me?.profile?.consent_at ? <p className="aa-faint" style={{ margin: 0 }}>You gave consent before. Ticking again confirms it.</p> : null}
            </div>
        </Stepper>
    )
}

export default function SetupSection({ initialStep = null }) {
    const me = useAutoApplyMe()
    const [params, setParams] = useSearchParams()
    const rawWanted = params.get('step') || initialStep
    const wanted = STEP_ALIAS[rawWanted] || rawWanted
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
    const pf = m.prefs || {}
    const missing = (m.readiness?.missing || m.profile_check?.missing || []).map((x) => (x && typeof x === 'object' ? x.key : String(x || '')))
    const NON_ANSWER = new Set(['onboarding', 'resume', 'email', 'prefs', 'titles', 'consent'])
    const resumeDone = !!(m.resume_path || prof.resume_path) && !missing.includes('resume')
    const done = {
        role: Array.isArray(pf.titles) && pf.titles.length > 0 && !!pf.current_employer,
        location: Array.isArray(pf.locations) && pf.locations.length > 0,
        resume: resumeDone,
        answers: resumeDone && !missing.some((k) => !NON_ANSWER.has(k)),
        review: !!(m.consent_at && m.onboarding_done) && !missing.includes('email'),
    }
    const allDone = SETUP_ORDER.every((id) => done[id])
    const [reached, setReached] = useState(0) // steps opened with Continue in this visit stay open
    const unlocked = (i) => i === 0 || i <= reached || SETUP_ORDER.slice(0, i).every((id) => done[id])
    const firstOpen = Math.max(0, SETUP_ORDER.findIndex((id) => !done[id]))
    const stepId = SETUP_ORDER.includes(wanted) ? wanted : SETUP_ORDER[allDone ? SETUP_ORDER.length - 1 : firstOpen]
    const idx = SETUP_ORDER.indexOf(stepId)

    const setStep = (id, replace = false) => { setParams({ step: id }, { replace }); window.scrollTo?.(0, 0) }
    const go = (id) => { const i = SETUP_ORDER.indexOf(id); if (i >= 0 && unlocked(i)) setStep(id) }
    const next = () => {
        if (idx < SETUP_ORDER.length - 1) {
            setReached((r) => Math.max(r, idx + 1))
            setStep(SETUP_ORDER[idx + 1])
        }
    }
    const back = idx > 0 ? () => setStep(SETUP_ORDER[idx - 1]) : undefined

    // a deep link to a locked step falls back to the first unfinished one
    useEffect(() => {
        if (me.data && !unlocked(idx)) setStep(SETUP_ORDER[firstOpen], true)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [me.data, idx])

    // funnel event + remembered step (this device only, the step id, never answers) whenever a step opens
    const loaded = !!me.data
    useEffect(() => {
        if (!loaded) return
        track(TRACK.SETUP_STEP, { step: idx + 1, of: TOTAL, label: stepId })
        if (!m.onboarding_done) writeSetupStep(stepId)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stepId, loaded])

    if (me.isLoading) return <LoadingState label="Loading…" />
    if (me.isError) return <ErrorState err={me.error} onRetry={() => me.refetch()} title="Could not load your setup" />
    if (!me.data) return null
    return (
        <div className="aa-setup">
            {stepId === 'role' && <RoleStep key="role" me={me.data} onNext={next} />}
            {stepId === 'location' && <LocationStep key="location" me={me.data} onNext={next} onBack={back} />}
            {stepId === 'resume' && <ResumeStep me={me.data} onNext={next} onBack={back} draft={draft || {}} setDraft={setDraft} />}
            {stepId === 'answers' && <AnswersStep onNext={next} onBack={back} draft={draft} />}
            {stepId === 'review' && <ReviewStep me={me.data} done={done} onBack={back} go={go} />}
        </div>
    )
}

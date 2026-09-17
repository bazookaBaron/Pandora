import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../../components/Navbar'
import { useJobs, useJobsAnalytics, useJobsTrend, useJobFacet } from '../../lib/useJobs'
import { LoadingState, ErrorState, EmptyState } from '../../components/shared/states'
import { LockedSlice } from '../../components/shared/PaywallGate'
import { useAuth } from '../../contexts/AuthContext'
import { useEntitlements } from '../../lib/useEntitlements'
import { useCompanySubscriptions, useSubscribeToCompany, useUnsubscribeFromCompany } from '../../lib/useCompanySubscriptions'

// ── helpers ────────────────────────────────────────────────────────
function relTime(iso) {
    if (!iso) return ''
    const t = new Date(iso).getTime()
    if (Number.isNaN(t)) return ''
    const s = (Date.now() - t) / 1000
    if (s < 90) return 'just now'
    if (s < 3600) return Math.round(s / 60) + 'm ago'
    if (s < 86400) return Math.round(s / 3600) + 'h ago'
    return Math.round(s / 86400) + 'd ago'
}

const LOC_TONE = { remote: '#4ade80', hybrid: '#22d3ee', onsite: '#f472b6' }
const SEN_TONE = {
    intern: '#a1a1aa', junior: '#38bdf8', mid: '#4ade80',
    senior: '#fbbf24', staff: '#fb923c', principal: '#f472b6', unknown: '#52525b',
}
const SEN_LABEL = {
    intern: 'Intern', junior: 'Junior (0–2y)', mid: 'Mid (2–4y)',
    senior: 'Senior (4–8y)', staff: 'Staff (8y+)', principal: 'Principal', unknown: 'Unspecified',
}
const COMPANY_TYPE_LABEL = { product: 'Product', startup: 'Startup', service: 'Service', unknown: 'Unspecified' }
const COMPANY_TYPE_TONE = { product: '#22d3ee', startup: '#a78bfa', service: '#fb923c', unknown: '#52525b' }

function BellIcon({ filled }) {
    return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill={filled ? 'currentColor' : 'none'}
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
    )
}

function bellBtnStyle(active, disabled) {
    return {
        flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 26, height: 26, borderRadius: 6, border: '1px solid var(--subtle)',
        background: active ? 'rgba(167,139,250,0.16)' : 'transparent',
        color: active ? '#a78bfa' : 'var(--muted)',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1, padding: 0,
    }
}

// Per-card "subscribe to this company's job alerts" toggle — same feature and
// server-side gating as JobsCompanyPage's SubscribeButton (config/tiers.js:
// company_subscriptions_max, Pro/Max only), just icon-sized so it works
// inline on a job card without sending someone to the company's hub page
// first. Every card on a page shares the one `useCompanySubscriptions` query
// (react-query dedupes by key), so this is one network read, not N.
function SubscribeBell({ slug, companyName }) {
    const { user } = useAuth()
    const navigate = useNavigate()
    const { plan, isLoading: planLoading } = useEntitlements()
    const { data } = useCompanySubscriptions()
    const subscribe = useSubscribeToCompany()
    const unsubscribe = useUnsubscribeFromCompany()

    if (!slug) return null

    if (!user) {
        return (
            <button type="button" title={`Log in to get alerts for ${companyName || 'this company'}`}
                onClick={(e) => { e.preventDefault(); navigate('/auth') }} style={bellBtnStyle(false, false)}>
                <BellIcon filled={false} />
            </button>
        )
    }
    if (planLoading) return <span style={{ width: 26, height: 26, flexShrink: 0 }} />

    if (plan === 'free') {
        return (
            <button type="button" title="Upgrade to Pro or Max to get job alerts for this company"
                onClick={(e) => { e.preventDefault(); navigate('/pricing') }} style={bellBtnStyle(false, false)}>
                <BellIcon filled={false} />
            </button>
        )
    }

    const subscriptions = data?.subscriptions || []
    const limit = data?.limit === 'unlimited' ? Infinity : Number(data?.limit ?? 0)
    const isSubscribed = subscriptions.some((s) => s.company_slug === slug)
    const atCap = !isSubscribed && Number.isFinite(limit) && subscriptions.length >= limit
    const busy = subscribe.isPending || unsubscribe.isPending
    const disabled = busy || (atCap && !isSubscribed)

    const toggle = async (e) => {
        e.preventDefault()
        if (disabled) return
        try {
            if (isSubscribed) await unsubscribe.mutateAsync(slug)
            else await subscribe.mutateAsync({ companySlug: slug, companyName: companyName || slug })
        } catch {
            /* a card has no room for an inline error — the profile page shows the full state */
        }
    }

    const label = isSubscribed
        ? `Subscribed to ${companyName || slug} — click to unsubscribe`
        : atCap
            ? `Limit reached (${subscriptions.length}/${limit}) — manage on your profile`
            : `Get emailed when ${companyName || 'this company'} posts new roles`

    return (
        <button type="button" title={label} onClick={toggle} disabled={disabled} style={bellBtnStyle(isSubscribed, disabled)}>
            <BellIcon filled={isSubscribed} />
        </button>
    )
}

// ── one job row ────────────────────────────────────────────────────
// Minimal inline row: title + a NEW tick, one faint meta line underneath
// (company · location · work-type · level · age), and a small Apply button
// pinned right. No pills — colour is carried by the text itself.
function JobCard({ j }) {
    const fresh = j.firstSeen && (Date.now() - new Date(j.firstSeen).getTime()) < 48 * 3600 * 1000
    const locTone = LOC_TONE[j.locationType]
    const sen = j.seniority && j.seniority !== 'unknown' ? j.seniority : ''

    const meta = []
    if (j.company) meta.push(<span style={{ color: 'var(--accent)', fontWeight: 600 }}>{j.company}</span>)
    if (j.location) meta.push(j.location)
    if (j.locationType) meta.push(<span style={{ color: locTone || 'inherit' }}>{j.locationType}</span>)
    if (j.companyType && j.companyType !== 'unknown') meta.push(COMPANY_TYPE_LABEL[j.companyType] || j.companyType)
    if (sen) meta.push(SEN_LABEL[sen] || sen)
    if (j.firstSeen) meta.push(relTime(j.firstSeen))

    return (
        <div className="job-card" style={{
            display: 'flex', alignItems: 'center', gap: 12,
            background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 8,
            padding: '10px 12px', minWidth: 0, maxWidth: '100%', overflow: 'hidden',
        }}>
            <div style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0, overflow: 'hidden' }}>
                    <a href={j.url} target="_blank" rel="noopener noreferrer" style={{
                        flex: '1 1 auto', minWidth: 0, display: 'block',
                        fontWeight: 750, fontSize: '0.85rem', color: 'var(--bright)', letterSpacing: '-0.01em',
                        textDecoration: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                        {j.title || 'Untitled role'}
                    </a>
                    {fresh && (
                        <span style={{
                            flexShrink: 0, fontSize: '0.55rem', fontWeight: 900,
                            letterSpacing: '0.09em', color: '#fbbf24',
                        }}>NEW</span>
                    )}
                </div>
                <div style={{
                    marginTop: 3, fontSize: '0.72rem', color: 'var(--muted)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                    {meta.map((m, i) => (
                        <span key={i}>
                            {i > 0 && <span style={{ opacity: 0.4 }}>{' · '}</span>}
                            {m}
                        </span>
                    ))}
                </div>
            </div>

            <SubscribeBell slug={j.companySlug} companyName={j.company} />

            <a href={j.url} target="_blank" rel="noopener noreferrer" className="job-apply" style={{
                flexShrink: 0, padding: '4px 11px', borderRadius: 6,
                border: '1px solid var(--subtle)', color: 'var(--pop)',
                fontSize: '0.7rem', fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap',
            }}>
                Apply ↗
            </a>
        </div>
    )
}

// ── controls ───────────────────────────────────────────────────────
function Segmented({ value, onChange, options, size = 'md' }) {
    const pad = size === 'sm' ? '3px 9px' : '4px 11px'
    return (
        <div style={{ display: 'inline-flex', background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 8, padding: 3, gap: 2 }}>
            {options.map((o) => {
                const active = value === o.value
                return (
                    <button key={o.value || 'all'} type="button" onClick={() => onChange(o.value)} style={{
                        padding: pad, borderRadius: 6, border: 'none', cursor: 'pointer',
                        fontSize: '0.72rem', fontWeight: 700,
                        background: active ? 'var(--subtle)' : 'transparent',
                        color: active ? 'var(--bright)' : 'var(--muted)',
                    }}>
                        {o.label}
                    </button>
                )
            })}
        </div>
    )
}

const selStyle = { flex: '0 1 150px', minWidth: 0 }

// Result-aware autocomplete: suggestions come from /api/jobs/facets, which only
// returns company / location values that occur in the current open job set, fuzzy
// -ranked against what's typed. Free text still works — Enter applies it as-is.
// `multiple`: `value` is a string[] of picked values, rendered as removable chips.
function FacetCombobox({ field, value, onChange, placeholder, style, multiple = false }) {
    const selected = multiple ? (Array.isArray(value) ? value : []) : []
    const [text, setText] = useState(multiple ? '' : (value || ''))
    const [open, setOpen] = useState(false)
    const [q, setQ] = useState('')
    const boxRef = useRef(null)

    useEffect(() => { if (!multiple) setText(value || '') }, [value, multiple])
    // Debounce the suggestion query; for single-select, also apply free text live.
    useEffect(() => {
        const t = setTimeout(() => {
            setQ(text.trim())
            if (!multiple) onChange(text.trim())
        }, 250)
        return () => clearTimeout(t)
    }, [text]) // eslint-disable-line react-hooks/exhaustive-deps

    const { options } = useJobFacet(field, q, open)
    const shown = multiple
        ? options.filter((o) => !selected.some((s) => s.toLowerCase() === o.toLowerCase()))
        : options

    useEffect(() => {
        if (!open) return
        const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
        document.addEventListener('mousedown', onDoc)
        return () => document.removeEventListener('mousedown', onDoc)
    }, [open])

    const commit = (v) => {
        if (multiple) {
            const val = (v || '').trim()
            if (val && !selected.some((s) => s.toLowerCase() === val.toLowerCase())) onChange([...selected, val])
            setText(''); setOpen(false)
            return
        }
        setText(v); onChange(v); setOpen(false)
    }
    const removeChip = (chip) => onChange(selected.filter((s) => s !== chip))

    return (
        <div ref={boxRef} style={{ position: 'relative', ...style }}>
            {multiple && selected.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
                    {selected.map((chip) => (
                        <span key={chip} style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            background: 'var(--subtle)', color: 'var(--accent)', borderRadius: 999,
                            padding: '2px 4px 2px 9px', fontSize: '0.7rem', fontWeight: 600, maxWidth: '100%',
                        }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chip}</span>
                            <button type="button" aria-label={`Remove ${chip}`} onClick={() => removeChip(chip)}
                                style={{
                                    flexShrink: 0, background: 'none', border: 'none', color: 'var(--faint)',
                                    cursor: 'pointer', fontSize: '0.85rem', lineHeight: 1, padding: '0 3px',
                                }}>×</button>
                        </span>
                    ))}
                </div>
            )}
            <input
                className="input-field"
                placeholder={multiple && selected.length ? 'Add another…' : placeholder}
                value={text}
                onChange={(e) => { setText(e.target.value); setOpen(true) }}
                onFocus={() => setOpen(true)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') commit(multiple ? text : text.trim())
                    else if (e.key === 'Escape') setOpen(false)
                    else if (e.key === 'Backspace' && multiple && !text && selected.length) removeChip(selected[selected.length - 1])
                }}
                style={{ width: '100%', minWidth: 0, paddingRight: text ? 24 : undefined }}
            />
            {text && (
                <button type="button" aria-label="Clear" onMouseDown={(e) => e.preventDefault()}
                    onClick={() => (multiple ? (setText(''), setOpen(false)) : commit(''))}
                    style={{
                        position: 'absolute', right: 4, bottom: 9,
                        background: 'none', border: 'none', color: 'var(--faint)', cursor: 'pointer',
                        fontSize: '0.95rem', lineHeight: 1, padding: 4,
                    }}>×</button>
            )}
            {open && shown.length > 0 && (
                <div style={{
                    position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30,
                    background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 8,
                    maxHeight: 240, overflowY: 'auto', boxShadow: '0 8px 24px var(--overlay)',
                }}>
                    {shown.map((o, i) => (
                        <button key={o} type="button" onMouseDown={(e) => e.preventDefault()}
                            onClick={() => commit(o)}
                            style={{
                                display: 'block', width: '100%', textAlign: 'left', padding: '7px 11px',
                                background: 'none', border: 'none', cursor: 'pointer',
                                color: 'var(--accent)', fontSize: '0.76rem',
                                borderBottom: i === shown.length - 1 ? 'none' : '1px solid var(--subtle)',
                            }}>
                            {o}
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

// ── charts (dependency-free) ───────────────────────────────────────
function BarRow({ label, value, max, tone }) {
    const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.74rem' }}>
            <span style={{ width: 130, flexShrink: 0, color: 'var(--accent)', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {label}
            </span>
            <div style={{ flex: 1, height: 16, background: 'var(--panel)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: pct + '%', height: '100%', background: tone || '#22d3ee', opacity: 0.85, borderRadius: 4, transition: 'width .4s' }} />
            </div>
            <span style={{ width: 52, flexShrink: 0, color: 'var(--bright)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {value.toLocaleString()}
            </span>
        </div>
    )
}

function BarChart({ title, rows, toneFor }) {
    if (!rows || !rows.length) return null
    const max = Math.max(...rows.map((r) => r.value), 1)
    return (
        <div style={{ background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '14px 16px' }}>
            <h3 style={{ fontSize: '0.68rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', margin: '0 0 12px' }}>{title}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {rows.map((r) => <BarRow key={r.label} {...r} max={max} tone={toneFor ? toneFor(r) : r.tone} />)}
            </div>
        </div>
    )
}

// Dependency-free SVG line chart — mirrors BarChart's card styling. `points`
// is an ascending-by-period array of flat objects; `series` picks which keys
// to draw. Fixed viewBox + `width: 100%` keeps it legible from ~375px mobile
// up to desktop without a charting library.
function LineChart({ title, points, series }) {
    if (!points || points.length < 2) return null
    const width = 700, height = 220
    const padL = 42, padR = 12, padT = 10, padB = 26
    const innerW = width - padL - padR
    const innerH = height - padT - padB
    const maxY = Math.max(1, ...points.flatMap((p) => series.map((s) => Number(p[s.key]) || 0)))
    const x = (i) => padL + (points.length > 1 ? (innerW * i) / (points.length - 1) : innerW / 2)
    const y = (v) => padT + innerH - (innerH * v) / maxY

    const maxLabels = 6
    const labelStep = Math.max(1, Math.ceil(points.length / maxLabels))
    const fmtPeriod = (p) => (p.length > 7 ? p.slice(5) : p) // "2026-09-14" -> "09-14", "2026-09" stays

    return (
        <div style={{ background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                <h3 style={{ fontSize: '0.68rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', margin: 0 }}>
                    {title}
                </h3>
                <div style={{ display: 'flex', gap: 14 }}>
                    {series.map((s) => (
                        <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.68rem', color: 'var(--muted)', fontWeight: 700 }}>
                            <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color, flexShrink: 0 }} />
                            {s.label}
                        </span>
                    ))}
                </div>
            </div>
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} style={{ width: '100%', height: 'auto', display: 'block' }}>
                {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                    <line key={f} x1={padL} x2={width - padR} y1={padT + innerH * (1 - f)} y2={padT + innerH * (1 - f)}
                        stroke="var(--subtle)" strokeWidth="1" opacity={f === 0 ? 0.7 : 0.28} />
                ))}
                {[0, 0.5, 1].map((f) => (
                    <text key={f} x={padL - 7} y={padT + innerH * (1 - f) + 3} textAnchor="end" fontSize="9" fill="var(--muted)">
                        {Math.round(maxY * f).toLocaleString()}
                    </text>
                ))}
                {points.map((p, i) => (
                    (i % labelStep === 0 || i === points.length - 1) ? (
                        <text key={p.period} x={x(i)} y={height - 7} textAnchor="middle" fontSize="9" fill="var(--muted)">
                            {fmtPeriod(p.period)}
                        </text>
                    ) : null
                ))}
                {series.map((s) => (
                    <polyline key={s.key}
                        points={points.map((p, i) => `${x(i)},${y(Number(p[s.key]) || 0)}`).join(' ')}
                        fill="none" stroke={s.color} strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" />
                ))}
                {series.map((s) => points.map((p, i) => (
                    <circle key={s.key + p.period} cx={x(i)} cy={y(Number(p[s.key]) || 0)} r="2.5" fill={s.color} />
                )))}
            </svg>
        </div>
    )
}

function Metric({ label, value, accent }) {
    return (
        <div style={{ background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '12px 16px', flex: '1 1 150px' }}>
            <div style={{ fontSize: '1.5rem', fontWeight: 900, color: accent || 'var(--bright)', letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
                {value}
            </div>
            <div style={{ fontSize: '0.66rem', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>
                {label}
            </div>
        </div>
    )
}

// Historical hiring-velocity trend (public.jobs_market_snapshot_daily via
// /api/jobs/analytics/trend). Independent data source from the live RPC above
// — renders (and handles its own empty/error state) whether or not the live
// snapshot has data yet.
function TrendView() {
    const [granularity, setGranularity] = useState('weekly')
    const { data, isLoading, error } = useJobsTrend(granularity, true)
    const points = data.points || []

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <h2 style={{ fontSize: '0.9rem', fontWeight: 900, color: 'var(--bright)', letterSpacing: '-0.01em', margin: 0 }}>
                    Historical trend
                </h2>
                <div className="profile-segment" role="group" aria-label="Trend granularity" style={{ maxWidth: 180 }}>
                    {['weekly', 'monthly'].map((g) => (
                        <button key={g} type="button"
                            className={'profile-segment-btn' + (granularity === g ? ' is-active' : '')}
                            aria-pressed={granularity === g}
                            onClick={() => setGranularity(g)}>
                            {g === 'weekly' ? 'Weekly' : 'Monthly'}
                        </button>
                    ))}
                </div>
            </div>

            {isLoading ? (
                <LoadingState label="Loading trend…" />
            ) : error || points.length === 0 ? (
                <div style={{
                    background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10,
                    padding: '16px', color: 'var(--muted)', fontSize: '0.78rem',
                }}>
                    Historical trend data isn't available yet — it populates once the crawler's daily market
                    snapshot has run for a few {granularity === 'monthly' ? 'months' : 'weeks'}.
                </div>
            ) : (
                (() => {
                    const latest = points[points.length - 1]
                    const countryRows = Object.entries(latest.byCountry || {}).map(([k, v]) => ({
                        label: k, value: v, tone: k === 'US' ? '#38bdf8' : k === 'IN' ? '#4ade80' : '#a1a1aa',
                    }))
                    const typeRows = Object.entries(latest.byCompanyType || {}).map(([k, v]) => ({
                        label: COMPANY_TYPE_LABEL[k] || k, value: v, tone: COMPANY_TYPE_TONE[k] || '#a1a1aa',
                    }))
                    return (
                        <>
                            <LineChart
                                title={`Hiring velocity — ${granularity}`}
                                points={points}
                                series={[
                                    { key: 'newPostings', label: 'New postings', color: '#22d3ee' },
                                    { key: 'totalOpen', label: 'Total open', color: '#a78bfa' },
                                ]}
                            />
                            {(countryRows.length > 0 || typeRows.length > 0) && (
                                <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
                                    {countryRows.length > 0 && <BarChart title="Latest period — by country" rows={countryRows} />}
                                    {typeRows.length > 0 && <BarChart title="Latest period — by company type" rows={typeRows} />}
                                </div>
                            )}
                        </>
                    )
                })()
            )}
        </div>
    )
}

// ── Analytics tab ──────────────────────────────────────────────────
function AnalyticsView() {
    const { data, isLoading, error, refetch } = useJobsAnalytics(true)

    if (isLoading) return <LoadingState label="Crunching numbers…" />
    if (error) return <ErrorState err={error} onRetry={refetch} />

    const liveReady = !(data.notReady || data.total === 0)
    const senRows = (data.bySeniority || []).map((s) => ({
        label: SEN_LABEL[s.bucket] || s.bucket, value: s.count, tone: SEN_TONE[s.bucket] || '#a1a1aa',
    }))
    const wtRows = (data.byWorkType || []).map((w) => ({
        label: w.type === 'unspecified' ? 'Unspecified' : w.type[0].toUpperCase() + w.type.slice(1),
        value: w.count, tone: LOC_TONE[w.type] || '#52525b',
    }))
    const srcRows = (data.bySource || []).slice(0, 10).map((s) => ({ label: s.source, value: s.count, tone: '#a78bfa' }))
    const coRows = (data.topCompanies || []).slice(0, 12).map((c) => ({ label: c.company, value: c.count, tone: '#38bdf8' }))

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            {liveReady ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                        <Metric label="Open postings" value={data.total.toLocaleString()} accent="#22d3ee" />
                        <Metric label="Companies hiring" value={(data.companiesWithJobs ?? '—').toLocaleString?.() ?? '—'} />
                        <Metric label="Mid-level (2–4y) share" value={data.midSharePct != null ? data.midSharePct + '%' : '—'} accent="#4ade80" />
                    </div>

                    <BarChart title="By seniority" rows={senRows} />
                    <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
                        <BarChart title="By work type" rows={wtRows} />
                        {srcRows.length > 0 && <BarChart title="By source (ATS)" rows={srcRows} />}
                    </div>
                    {coRows.length > 0 && <BarChart title="Top companies by open roles" rows={coRows} />}
                </div>
            ) : (
                <EmptyState icon="📊" title="No data yet" message="Analytics populate once the crawler has indexed jobs." />
            )}

            <TrendView />
        </div>
    )
}

// ── Listings tab ───────────────────────────────────────────────────
function ListingsView() {
    const [search, setSearch] = useState('') // free text — FacetCombobox debounces it
    const [company, setCompany] = useState('')
    const [locations, setLocations] = useState([]) // multi-select
    const [locationType, setLocationType] = useState('')
    const [companyType, setCompanyType] = useState('')
    const [source, setSource] = useState('')
    const [seniority, setSeniority] = useState('')
    const [postedWithin, setPostedWithin] = useState('')
    const [sort, setSort] = useState('newest')
    const [page, setPage] = useState(1)

    const locationParam = locations.join(',')

    useEffect(() => { setPage(1) }, [search, company, locationParam, locationType, companyType, source, seniority, postedWithin, sort])

    const { data, isLoading, isFetching, error, refetch } =
        useJobs({ search, company, location: locationParam, locationType, companyType, source, seniority, postedWithin, sort, page })

    const sourceOptions = useMemo(
        () => [{ value: '', label: 'All sources' }, ...(data.facets?.sources || []).map((s) => ({ value: s, label: s }))],
        [data.facets],
    )
    const anyFilter = search || company || locations.length || locationType || companyType || source || seniority || postedWithin

    return (
        <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                <FacetCombobox field="title" value={search} onChange={setSearch}
                    placeholder="Search job title or company…" style={{ flex: '1 1 220px' }} />
                <FacetCombobox field="company" value={company} onChange={setCompany}
                    placeholder="Company" style={{ flex: '0 1 160px' }} />
                <FacetCombobox field="location" multiple value={locations} onChange={setLocations}
                    placeholder="Locations" style={{ flex: '1 1 200px' }} />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 16 }}>
                <Segmented value={locationType} onChange={setLocationType} options={[
                    { value: '', label: 'Any' }, { value: 'remote', label: 'Remote' },
                    { value: 'hybrid', label: 'Hybrid' }, { value: 'onsite', label: 'Onsite' },
                ]} />
                <Segmented value={companyType} onChange={setCompanyType} options={[
                    { value: '', label: 'All' }, { value: 'product', label: 'Product' },
                    { value: 'startup', label: 'Startup' }, { value: 'service', label: 'Service' },
                ]} />
                <select className="input-field" value={seniority} onChange={(e) => setSeniority(e.target.value)} style={selStyle}>
                    <option value="">Any level</option>
                    {['intern', 'junior', 'mid', 'senior', 'staff', 'principal'].map((s) => (
                        <option key={s} value={s}>{SEN_LABEL[s]}</option>
                    ))}
                </select>
                <select className="input-field" value={postedWithin} onChange={(e) => setPostedWithin(e.target.value)} style={selStyle}>
                    <option value="">Any time (≤ 24 hours)</option>
                    <option value="1">Past 24 hours</option>
                </select>
                {sourceOptions.length > 1 && (
                    <select className="input-field" value={source} onChange={(e) => setSource(e.target.value)} style={selStyle}>
                        {sourceOptions.map((o) => <option key={o.value || 'all'} value={o.value}>{o.label}</option>)}
                    </select>
                )}
                <select className="input-field" value={sort} onChange={(e) => setSort(e.target.value)} style={selStyle}>
                    <option value="newest">Latest first</option>
                    <option value="oldest">Oldest first</option>
                    <option value="company">By company</option>
                </select>
            </div>

            {isLoading ? (
                <LoadingState label="Loading jobs…" />
            ) : error ? (
                <ErrorState err={error} onRetry={refetch} />
            ) : data.items.length === 0 ? (
                <EmptyState
                    icon="🗂️"
                    title={data.notReady ? 'Jobs feed not live yet' : 'No matching jobs'}
                    message={data.notReady
                        ? 'The crawler hasn’t run its first pass yet.'
                        : (anyFilter ? 'Try loosening the filters.' : 'No open postings right now.')}
                />
            ) : (
                <>
                    <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginBottom: 10, fontWeight: 700 }}>
                        {data.total.toLocaleString()} job{data.total === 1 ? '' : 's'}
                        {isFetching && <span style={{ color: 'var(--faint)', fontWeight: 400 }}> · updating…</span>}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6, opacity: isFetching ? 0.6 : 1, transition: 'opacity .15s' }}>
                        {data.items.map((j) => <JobCard key={j.id} j={j} />)}
                    </div>
                    {data.locked > 0 && (
                        <LockedSlice count={data.locked} noun="job listings" variant="row" rows={3} />
                    )}
                    {data.pageCount > 1 && (
                        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 20 }}>
                            <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} style={pagerBtn(page <= 1)}>← Prev</button>
                            <span style={{ fontSize: '0.74rem', color: 'var(--muted)', fontWeight: 700 }}>{data.page} / {data.pageCount}</span>
                            <button type="button" onClick={() => setPage((p) => Math.min(data.pageCount, p + 1))} disabled={page >= data.pageCount} style={pagerBtn(page >= data.pageCount)}>Next →</button>
                        </div>
                    )}
                </>
            )}
        </>
    )
}

function pagerBtn(disabled) {
    return {
        padding: '6px 14px', borderRadius: 6, border: '1px solid var(--subtle)',
        background: 'none', color: disabled ? 'var(--subtle-strong)' : 'var(--accent)',
        cursor: disabled ? 'default' : 'pointer', fontSize: '0.74rem', fontWeight: 700,
    }
}

// ── page ───────────────────────────────────────────────────────────
const TABS = [['listings', 'Listings'], ['analytics', 'Analytics']]

export default function JobsPage() {
    const [tab, setTab] = useState('listings')
    return (
        <>
            <Navbar />
            <main className="wrap" style={{ maxWidth: 980, margin: '0 auto', padding: '72px 16px 48px' }}>
                <header style={{ marginBottom: 16 }}>
                    <h1 style={{ fontSize: '1.4rem', fontWeight: 900, color: 'var(--bright)', letterSpacing: '-0.03em' }}>Jobs</h1>
                    <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: 6 }}>
                        Tech openings crawled from ~500 companies, refreshed through the day. Only jobs from the last 24 hours — anything older is dropped.
                    </p>
                </header>

                <div className="profile-segment" role="tablist" aria-label="Jobs views" style={{ maxWidth: 320, marginBottom: 18 }}>
                    {TABS.map(([id, label]) => (
                        <button key={id} type="button" role="tab" aria-selected={tab === id}
                            className={'profile-segment-btn' + (tab === id ? ' is-active' : '')}
                            onClick={() => setTab(id)}>
                            {label}
                        </button>
                    ))}
                </div>

                {tab === 'listings' ? <ListingsView /> : <AnalyticsView />}
            </main>
        </>
    )
}

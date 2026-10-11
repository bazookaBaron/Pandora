import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import Navbar from '../../components/Navbar'
import { useJobs, useJobsAnalytics, useJobsTrend, useJobFacet } from '../../lib/useJobs'
import { LoadingState, ErrorState, EmptyState } from '../../components/shared/states'
import { LockedSlice } from '../../components/shared/PaywallGate'
import { useAuth } from '../../contexts/AuthContext'
import { useTheme } from '../../contexts/ThemeContext'
import { useEntitlements } from '../../lib/useEntitlements'
import { useCompanySubscriptions, useSubscribeToCompany, useUnsubscribeFromCompany } from '../../lib/useCompanySubscriptions'
import { TRACKED_COMPANIES, JOBS_SCOPE_LABEL } from '../../../config/siteFacts.js'

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
const SEN_LABEL = {
    intern: 'Intern', junior: 'Junior (0–2y)', mid: 'Mid (2–4y)',
    senior: 'Senior (4–8y)', staff: 'Staff (8y+)', principal: 'Principal', unknown: 'Unspecified',
}
const COMPANY_TYPE_LABEL = { product: 'Product', startup: 'Startup', service: 'Service', unknown: 'Unspecified' }

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
// ── analytics chart palette ──────────────────────────────────────────
// Validated against this app's real card surfaces (dark --panel #18181b,
// light #ffffff) with the dataviz skill's validate_palette.js — categorical
// hues from the documented default palette's fixed slot order (never
// eyeballed), seniority as a one-hue ORDINAL ramp (it's a progression —
// intern→principal — not an unordered identity set, so it gets monotone
// lightness instead of scattered hues). The light-mode seniority ramp has
// two adjacent steps slightly under the ideal ΔL gap (only ~10 usable named
// steps clear the light-surface contrast floor); every segment carries a
// direct value label, which is this skill's documented relief for exactly
// that case.
const CHART_PALETTE = {
    dark: {
        categorical3: ['#3987e5', '#d95926', '#199e70'],
        country: ['#3987e5', '#199e70'],
        seniorityRamp: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'],
    },
    light: {
        categorical3: ['#2a78d6', '#eb6834', '#1baf7a'],
        country: ['#2a78d6', '#1baf7a'],
        seniorityRamp: ['#86b6ef', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#104281'],
    },
}
function useChartPalette() {
    const { theme } = useTheme()
    return CHART_PALETTE[theme === 'light' ? 'light' : 'dark']
}

// Sums the known ordered keys into labeled/colored segments, and folds
// anything else in the raw dict (nulls, an ATS-specific value we didn't
// enumerate) into one trailing "Other" segment — so a chart never silently
// drops jobs just because their bucket wasn't one we anticipated.
function segmentsWithOther(dict, order, labelFor, colors, otherLabel) {
    const known = order.map((k, i) => ({ label: labelFor(k), value: Number(dict?.[k]) || 0, color: colors[i] }))
    const knownSum = known.reduce((s, x) => s + x.value, 0)
    const total = Object.values(dict || {}).reduce((s, v) => s + (Number(v) || 0), 0)
    const rest = total - knownSum
    return rest > 0 ? [...known, { label: otherLabel, value: rest, color: 'var(--faint)' }] : known
}

// Single-bar composition snapshot — one bar split proportionally into its
// categories, so "what's the mix right now" reads as one whole instead of
// several independent bars competing for the eye. Segments are too narrow
// for in-bar text, so identity + share % live in the legend row below
// (never color-alone, per the ≥2-series rule).
function StackedBar({ title, segments }) {
    const shown = (segments || []).filter((s) => s.value > 0)
    const total = shown.reduce((s, x) => s + x.value, 0)
    if (!total) return null
    return (
        <div style={{ background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '14px 16px' }}>
            <h3 style={{ fontSize: '0.68rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', margin: '0 0 10px' }}>
                {title}
            </h3>
            <div style={{ display: 'flex', height: 20, borderRadius: 5, overflow: 'hidden', gap: 2 }}>
                {shown.map((s) => (
                    <div key={s.label} title={`${s.label}: ${s.value.toLocaleString()} (${Math.round((s.value / total) * 100)}%)`}
                        style={{ flex: s.value, background: s.color, minWidth: 3 }} />
                ))}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 14px', marginTop: 10 }}>
                {shown.map((s) => (
                    <span key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.7rem' }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
                        <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{s.label}</span>
                        <span style={{ fontWeight: 700, color: 'var(--bright)', fontVariantNumeric: 'tabular-nums' }}>
                            {Math.round((s.value / total) * 100)}%
                        </span>
                    </span>
                ))}
            </div>
        </div>
    )
}

// "Who's hiring the most right now" — ranked by NEW postings this period
// (the snapshot's top_companies), not total open roles. A leaderboard by
// total-open is dominated forever by whoever has the biggest perpetual
// pipeline; this one moves week to week and actually says something.
function TrendingCompaniesList({ companies }) {
    const rows = companies || []
    if (!rows.length) return null
    const max = Math.max(...rows.map((c) => c.count), 1)
    return (
        <div style={{ background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '14px 16px' }}>
            <h3 style={{ fontSize: '0.68rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', margin: '0 0 10px' }}>
                Trending companies this period
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
                {rows.slice(0, 10).map((c, i) => (
                    <div key={c.company} style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '6px 2px',
                        borderTop: i === 0 ? 'none' : '1px solid var(--subtle)',
                    }}>
                        <span style={{ width: 18, flexShrink: 0, fontSize: '0.68rem', color: 'var(--faint)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                            {i + 1}
                        </span>
                        <span style={{ flex: 1, minWidth: 0, fontSize: '0.78rem', color: 'var(--accent)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {c.company}
                        </span>
                        <div style={{ width: 70, height: 5, background: 'var(--subtle)', borderRadius: 3, overflow: 'hidden', flexShrink: 0 }}>
                            <div style={{ width: `${Math.max(6, (c.count / max) * 100)}%`, height: '100%', background: 'var(--pop)' }} />
                        </div>
                        <span style={{ width: 34, flexShrink: 0, textAlign: 'right', fontSize: '0.74rem', fontWeight: 800, color: 'var(--bright)', fontVariantNumeric: 'tabular-nums' }}>
                            +{c.count}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    )
}

// Up/down vs the prior period — status color (never a categorical hue),
// always icon + number so it never leans on color alone.
function DeltaTag({ curr, prev }) {
    if (prev == null || prev === 0) return null
    const pct = Math.round(((curr - prev) / prev) * 100)
    if (pct === 0) return null
    const up = pct > 0
    return (
        <span style={{ fontSize: '0.78rem', fontWeight: 800, color: up ? '#0ca30c' : '#e66767', marginLeft: 8 }}>
            {up ? '▲' : '▼'} {Math.abs(pct)}%
        </span>
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

// Stacked-area composition TREND — same part-to-whole job as StackedBar, run
// across time, so a mix shift (India's share of the board growing, say)
// shows up as a widening band instead of two snapshot numbers you have to
// compare by hand. `keys` bottom→top; `points` need only carry those keys +
// `period`.
function StackedAreaChart({ title, points, keys, colors, labelFor }) {
    if (!points || points.length < 2) return null
    const width = 700, height = 200
    const padL = 42, padR = 12, padT = 10, padB = 26
    const innerW = width - padL - padR
    const innerH = height - padT - padB
    const totals = points.map((p) => keys.reduce((s, k) => s + (Number(p[k]) || 0), 0))
    const maxTotal = Math.max(1, ...totals)
    const x = (i) => padL + (points.length > 1 ? (innerW * i) / (points.length - 1) : innerW / 2)
    const yTop = (v) => padT + innerH - (innerH * v) / maxTotal

    const maxLabels = 6
    const labelStep = Math.max(1, Math.ceil(points.length / maxLabels))
    const fmtPeriod = (p) => (p.length > 7 ? p.slice(5) : p)

    // Cumulative sums per point, bottom→top in `keys` order — each series'
    // fill runs between its own cumulative line and the one below it.
    const cum = points.map((p) => {
        let acc = 0
        return keys.map((k) => { acc += Number(p[k]) || 0; return acc })
    })

    return (
        <div style={{ background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                <h3 style={{ fontSize: '0.68rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', margin: 0 }}>
                    {title}
                </h3>
                <div style={{ display: 'flex', gap: 14 }}>
                    {keys.map((k, i) => (
                        <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.68rem', color: 'var(--muted)', fontWeight: 700 }}>
                            <span style={{ width: 9, height: 9, borderRadius: 2, background: colors[i], flexShrink: 0 }} />
                            {labelFor ? labelFor(k) : k}
                        </span>
                    ))}
                </div>
            </div>
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} style={{ width: '100%', height: 'auto', display: 'block' }}>
                {[0, 0.5, 1].map((f) => (
                    <line key={f} x1={padL} x2={width - padR} y1={padT + innerH * (1 - f)} y2={padT + innerH * (1 - f)}
                        stroke="var(--subtle)" strokeWidth="1" opacity={f === 0 ? 0.7 : 0.28} />
                ))}
                {points.map((p, i) => (
                    (i % labelStep === 0 || i === points.length - 1) ? (
                        <text key={p.period} x={x(i)} y={height - 7} textAnchor="middle" fontSize="9" fill="var(--muted)">
                            {fmtPeriod(p.period)}
                        </text>
                    ) : null
                ))}
                {keys.map((k, ki) => {
                    const top = points.map((_, i) => `${x(i)},${yTop(cum[i][ki])}`)
                    const bottom = points.map((_, i) => `${x(i)},${yTop(ki === 0 ? 0 : cum[i][ki - 1])}`).reverse()
                    return (
                        <polygon key={k} points={[...top, ...bottom].join(' ')}
                            fill={colors[ki]} opacity="0.82" stroke="var(--panel)" strokeWidth="1" />
                    )
                })}
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

const SENIORITY_ORDER = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal']
const WORK_TYPE_ORDER = ['remote', 'hybrid', 'onsite']
const COMPANY_TYPE_ORDER = ['product', 'startup', 'service']

// ── Analytics tab ──────────────────────────────────────────────────
// Two independent data sources, one page: `live` is the real-time RPC (just
// the headline "open right now" count — everything else here needs history,
// which live data doesn't have); `trend` is the daily market snapshot, which
// drives the velocity line, every composition chart (from its latest
// period), the geography-mix-over-time area chart, and the trending-company
// list. Cut from the old version: the ATS/source breakdown (an internal
// scraping detail, not a market signal) and the mid-level-share tile
// (an arbitrary single slice of the seniority chart that's shown in full
// below anyway).
function AnalyticsView() {
    const { data: live, isLoading: liveLoading, error: liveError, refetch } = useJobsAnalytics(true)
    const [granularity, setGranularity] = useState('weekly')
    const { data: trend, isLoading: trendLoading, error: trendError } = useJobsTrend(granularity, true)
    const palette = useChartPalette()

    if (liveLoading) return <LoadingState label="Crunching numbers…" />
    if (liveError) return <ErrorState err={liveError} onRetry={refetch} />

    const liveReady = !(live.notReady || live.total === 0)
    const points = trend.points || []
    const trendReady = !trendLoading && !trendError && points.length > 0
    const latest = trendReady ? points[points.length - 1] : null
    const prior = trendReady && points.length > 1 ? points[points.length - 2] : null

    const senSegments = latest
        ? segmentsWithOther(latest.bySeniority, SENIORITY_ORDER, (k) => SEN_LABEL[k] || k, palette.seniorityRamp, 'Unspecified')
        : []
    const wtSegments = latest
        ? segmentsWithOther(latest.byWorkType, WORK_TYPE_ORDER, (k) => k[0].toUpperCase() + k.slice(1), palette.categorical3, 'Unspecified')
        : []
    const countrySegments = latest
        ? segmentsWithOther(latest.byCountry, ['US', 'IN'], (k) => (k === 'US' ? 'United States' : 'India'), palette.country, 'Other')
        : []
    const typeSegments = latest
        ? segmentsWithOther(latest.byCompanyType, COMPANY_TYPE_ORDER, (k) => COMPANY_TYPE_LABEL[k] || k, palette.categorical3, 'Unknown')
        : []
    const trendingCompanies = (latest?.topCompanies || []).map((c) => ({ company: c.company, count: c.newPostings || 0 }))

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                    {/* Same set as the Listings tab (and its job count). */}
                    <Metric label="Live jobs on the board" value={liveReady ? live.total.toLocaleString() : '—'} accent="#22d3ee" />
                    <Metric label="Companies hiring" value={liveReady && live.companiesWithJobs != null ? live.companiesWithJobs.toLocaleString() : '—'} accent="#4ade80" />
                    {latest && (
                        <div style={{ background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '12px 16px', flex: '1 1 150px' }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', fontVariantNumeric: 'tabular-nums' }}>
                                <span style={{ fontSize: '1.5rem', fontWeight: 900, color: '#a78bfa', letterSpacing: '-0.02em' }}>
                                    {latest.newPerDay.toLocaleString()}
                                </span>
                                {prior && <DeltaTag curr={latest.newPerDay} prev={prior.newPerDay} />}
                            </div>
                            <div style={{ fontSize: '0.66rem', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>
                                New per day, all regions (avg this {granularity === 'monthly' ? 'month' : 'week'})
                            </div>
                        </div>
                    )}
                </div>
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

            {trendLoading ? (
                <LoadingState label="Loading trend…" />
            ) : !trendReady ? (
                liveReady ? (
                    <div style={{ background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '16px', color: 'var(--muted)', fontSize: '0.78rem' }}>
                        Trend &amp; composition data isn't available yet — it populates once the crawler's daily market
                        snapshot has run for a few {granularity === 'monthly' ? 'months' : 'weeks'}.
                    </div>
                ) : (
                    <EmptyState icon="📊" title="No data yet" message="Analytics populate once the crawler has indexed jobs." />
                )
            ) : (
                <>
                    <div style={{ fontSize: '0.74rem', color: 'var(--muted)' }}>
                        The trend below covers every region the crawler tracks, not just the board's US &amp; India window.{' '}
                        <Link to="/trends" style={{ color: 'var(--pop)', fontWeight: 700 }}>Daily reports →</Link>
                    </div>
                    <LineChart
                        title={`Hiring velocity — ${granularity}`}
                        points={points}
                        series={[
                            { key: 'newPerDay', label: 'New per day (avg)', color: '#22d3ee' },
                            { key: 'totalOpen', label: 'Tracked openings', color: '#a78bfa' },
                        ]}
                    />

                    <div>
                        <h2 style={{ fontSize: '0.9rem', fontWeight: 900, color: 'var(--bright)', letterSpacing: '-0.01em', margin: '0 0 12px' }}>
                            What the market's hiring for right now
                        </h2>
                        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
                            {senSegments.length > 0 && <StackedBar title="Seniority" segments={senSegments} />}
                            {wtSegments.length > 0 && <StackedBar title="Work type" segments={wtSegments} />}
                            {countrySegments.length > 0 && <StackedBar title="Geography" segments={countrySegments} />}
                            {typeSegments.length > 0 && <StackedBar title="Company type" segments={typeSegments} />}
                        </div>
                    </div>

                    <StackedAreaChart
                        title={`Geography mix over time — ${granularity}`}
                        points={points.map((p) => ({ period: p.period, US: p.byCountry?.US || 0, IN: p.byCountry?.IN || 0 }))}
                        keys={['IN', 'US']}
                        colors={[palette.country[1], palette.country[0]]}
                        labelFor={(k) => (k === 'IN' ? 'India' : 'United States')}
                    />

                    <TrendingCompaniesList companies={trendingCompanies} />
                </>
            )}
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
// Each tab has its own URL so the analytics view can be linked and indexed.
const TABS = [['listings', 'Listings', '/'], ['analytics', 'Analytics', '/jobs/analytics']]

export default function JobsPage() {
    const { pathname } = useLocation()
    const tab = pathname === '/jobs/analytics' ? 'analytics' : 'listings'
    return (
        <>
            <Navbar />
            <main className="wrap" style={{ maxWidth: 980, margin: '0 auto', padding: '72px 16px 48px' }}>
                <header style={{ marginBottom: 16 }}>
                    <h1 style={{ fontSize: '1.4rem', fontWeight: 900, color: 'var(--bright)', letterSpacing: '-0.03em' }}>
                        {tab === 'analytics' ? 'Job market analytics' : 'Jobs'}
                    </h1>
                    <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: 6 }}>
                        Tech openings from {TRACKED_COMPANIES} companies' career pages, refreshed through the day. The board shows {JOBS_SCOPE_LABEL}.
                    </p>
                </header>

                <nav className="profile-segment" aria-label="Jobs views" style={{ maxWidth: 320, marginBottom: 18 }}>
                    {TABS.map(([id, label, to]) => (
                        <Link key={id} to={to} aria-current={tab === id ? 'page' : undefined}
                            className={'profile-segment-btn' + (tab === id ? ' is-active' : '')}
                            style={{ textAlign: 'center', textDecoration: 'none' }}>
                            {label}
                        </Link>
                    ))}
                </nav>

                {tab === 'listings' ? <ListingsView /> : <AnalyticsView />}
            </main>
        </>
    )
}

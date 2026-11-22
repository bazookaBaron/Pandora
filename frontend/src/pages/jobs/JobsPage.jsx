import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Navbar from '../../components/Navbar'
import { PageContainer, PageHeader } from '../../components/shared/Layout'
import { useJobs, useJobFacet, useSearchRequest } from '../../lib/useJobs'
import { apiFetch } from '../../lib/apiClient'
import MarketAnalytics from './MarketAnalytics'
import { LoadingState, ErrorState, EmptyState } from '../../components/shared/states'
import { LockedSlice } from '../../components/shared/PaywallGate'
import { useAuth } from '../../contexts/AuthContext'
import { useEntitlements } from '../../lib/useEntitlements'
import { relTime, postedTime, isFreshJob, jobLinks, sourceLabel } from '../../lib/jobUtils'
import { useCompanySubscriptions, useSubscribeToCompany, useUnsubscribeFromCompany } from '../../lib/useCompanySubscriptions'

// ── helpers ────────────────────────────────────────────────────────
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
            /* the global mutation toast explains the failure (e.g. the plan's alert cap) */
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
    const fresh = isFreshJob(j)
    const { primary, alts } = jobLinks(j)
    const srcLabel = sourceLabel(j.source)
    const locTone = LOC_TONE[j.locationType]
    const sen = j.seniority && j.seniority !== 'unknown' ? j.seniority : ''

    const meta = []
    if (j.company) meta.push(<span style={{ color: 'var(--accent)', fontWeight: 600 }}>{j.company}</span>)
    if (j.location) meta.push(j.location)
    if (j.locationType) meta.push(<span style={{ color: locTone || 'inherit' }}>{j.locationType}</span>)
    if (j.companyType && j.companyType !== 'unknown') meta.push(COMPANY_TYPE_LABEL[j.companyType] || j.companyType)
    if (sen) meta.push(SEN_LABEL[sen] || sen)
    const when = relTime(postedTime(j))
    if (when) meta.push(when)
    if (srcLabel) meta.push(srcLabel)

    return (
        <div className="job-card" style={{
            display: 'flex', alignItems: 'center', gap: 12,
            background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 8,
            padding: '10px 12px', minWidth: 0, maxWidth: '100%', overflow: 'hidden',
        }}>
            <div style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0, overflow: 'hidden' }}>
                    <a href={primary || undefined} target="_blank" rel="noopener noreferrer" style={{
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
                    {j.isReposted && (
                        <span style={{
                            flexShrink: 0, fontSize: '0.55rem', fontWeight: 900,
                            letterSpacing: '0.09em', color: '#a78bfa',
                        }}>REPOSTED</span>
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

            <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                {primary && (
                    <a href={primary} target="_blank" rel="noopener noreferrer" className="job-apply" style={{
                        padding: '4px 11px', borderRadius: 6,
                        border: '1px solid var(--subtle)', color: 'var(--pop)',
                        fontSize: '0.7rem', fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap',
                    }}>
                        Apply ↗
                    </a>
                )}
                {alts.slice(0, 1).map((a) => (
                    <a key={a.href} href={a.href} target="_blank" rel="noopener noreferrer" style={{
                        fontSize: '0.62rem', color: 'var(--muted)', textDecoration: 'none', whiteSpace: 'nowrap',
                    }}>
                        also on {a.label}
                    </a>
                ))}
            </div>
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

// ── Listings tab ───────────────────────────────────────────────────
// Filters live in the URL (?q=&company=&loc=…&page=) so a reload, back
// button or shared link keeps them. Every setter resets the page in the same
// update, so changing a filter never fetches the stale page first.
const FILTER_PARAMS = { search: 'q', company: 'company', locations: 'loc', locationType: 'type', companyType: 'ctype', source: 'source', seniority: 'level', postedWithin: 'posted', sort: 'sort' }

function ListingsView() {
    const [params, setParams] = useSearchParams()
    const search = params.get('q') || ''
    const company = params.get('company') || ''
    const locationParam = params.get('loc') || ''
    const locations = useMemo(() => (locationParam ? locationParam.split(',').filter(Boolean) : []), [locationParam])
    const locationType = params.get('type') || ''
    const companyType = params.get('ctype') || ''
    const source = params.get('source') || ''
    const seniority = params.get('level') || ''
    const postedWithin = params.get('posted') || ''
    const sort = params.get('sort') || 'newest'
    const page = Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1)

    const setFilter = (name) => (value) => {
        setParams((prev) => {
            const next = new URLSearchParams(prev)
            const key = FILTER_PARAMS[name]
            const v = Array.isArray(value) ? value.join(',') : String(value ?? '')
            if (!v || (name === 'sort' && v === 'newest')) next.delete(key)
            else next.set(key, v)
            next.delete('page')
            return next
        }, { replace: true })
    }
    const setSearch = setFilter('search')
    const setCompany = setFilter('company')
    const setLocations = setFilter('locations')
    const setLocationType = setFilter('locationType')
    const setCompanyType = setFilter('companyType')
    const setSource = setFilter('source')
    const setSeniority = setFilter('seniority')
    const setPostedWithin = setFilter('postedWithin')
    const setSort = setFilter('sort')
    const setPage = (fn) => {
        setParams((prev) => {
            const next = new URLSearchParams(prev)
            const cur = Math.max(1, Number.parseInt(prev.get('page') || '1', 10) || 1)
            const n = typeof fn === 'function' ? fn(cur) : fn
            if (n <= 1) next.delete('page')
            else next.set('page', String(n))
            return next
        })
    }

    const { data, isLoading, isFetching, error, refetch } =
        useJobs({ search, company, location: locationParam, locationType, companyType, source, seniority, postedWithin, sort, page })

    const { user } = useAuth()
    const searchReq = useSearchRequest(!!user)
    const [reqState, setReqState] = useState('')
    const requestMore = async () => {
        setReqState('sending')
        try {
            const country = /united states|usa|\bus\b/i.test(locationParam) ? 'US' : 'IN'
            await apiFetch('/api/jobs/request-search', { json: { titles: [search], country, seniority: seniority || undefined } })
            setReqState('queued')
        } catch (e) {
            setReqState(e && e.status === 429 ? 'limited' : 'error')
        }
        searchReq.refetch()
    }

    const sourceOptions = useMemo(
        () => [{ value: '', label: 'All sources' }, ...(data.facets?.sources || []).map((s) => ({ value: s, label: s }))],
        [data.facets],
    )
    const anyFilter = search || company || locations.length || locationType || companyType || source || seniority || postedWithin

    return (
        <>
            <div className="pg-filterbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10, marginBottom: 20 }}>
            <div data-tour="jobs-filters" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                <FacetCombobox field="title" value={search} onChange={setSearch}
                    placeholder="Search job title or company…" style={{ flex: '1 1 220px' }} />
                <FacetCombobox field="company" value={company} onChange={setCompany}
                    placeholder="Company" style={{ flex: '0 1 160px' }} />
                <FacetCombobox field="location" multiple value={locations} onChange={setLocations}
                    placeholder="Locations" style={{ flex: '1 1 200px' }} />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', paddingTop: 10, borderTop: '1px solid var(--border)' }}>
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
                    {user && search && !isLoading && data.total < 10 && (
                        <div style={{ marginTop: 14, fontSize: '0.74rem', color: 'var(--muted)' }}>
                            {reqState === 'queued' || searchReq.data?.request?.status === 'queued'
                                ? 'We are searching more sources for this role. Check back later.'
                                : reqState === 'limited' ? 'You can request one extra search per day.'
                                : (
                                    <button type="button" onClick={requestMore} disabled={reqState === 'sending'}
                                        style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--subtle)', background: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.74rem', fontWeight: 700 }}>
                                        Search more for this role
                                    </button>
                                )}
                        </div>
                    )}
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
            <PageContainer>
                <PageHeader
                    title="Jobs"
                    subtitle="Tech openings crawled from ~500 companies, refreshed through the day. Only jobs from the last 24 hours."
                    actions={(
                        <div className="profile-segment" role="tablist" aria-label="Jobs views" style={{ minWidth: 220 }}>
                            {TABS.map(([id, label]) => (
                                <button key={id} type="button" role="tab" aria-selected={tab === id}
                                    className={'profile-segment-btn' + (tab === id ? ' is-active' : '')}
                                    onClick={() => setTab(id)}>
                                    {label}
                                </button>
                            ))}
                        </div>
                    )}
                />

                <div style={{ minWidth: 0 }}>
                    {tab === 'listings' ? <ListingsView /> : <MarketAnalytics />}
                </div>
            </PageContainer>
        </>
    )
}

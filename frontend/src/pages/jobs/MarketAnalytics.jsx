import { useState } from 'react'
import { useMarketAnalytics } from '../../lib/useJobs'
import { LoadingState, ErrorState, EmptyState } from '../../components/shared/states'

// Jobs -> Analytics: every number comes from our own crawler pool
// (server: /api/market/analytics). Plain CSS/SVG, light-first via theme vars.
const COUNTRIES = [['IN', 'India'], ['US', 'USA']]
const SEN_LABEL = { intern: 'Intern', junior: 'Junior', mid: 'Mid', senior: 'Senior', staff: 'Staff', principal: 'Principal', unknown: 'Not stated' }
const SEN_ORDER = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'unknown']
const TYPE_LABEL = { product: 'Product', service: 'Service', startup: 'Startup', unknown: 'Other' }

const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString() : '—')
const card = { background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '14px 16px', minWidth: 0 }
const h2 = { fontSize: '0.86rem', fontWeight: 900, color: 'var(--bright)', letterSpacing: '-0.01em', margin: '0 0 10px' }

function Stat({ label, value }) {
    return (
        <div style={{ ...card, padding: '12px 14px' }}>
            <div style={{ fontSize: '1.45rem', fontWeight: 900, color: 'var(--bright)', letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
            <div style={{ fontSize: '0.66rem', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>{label}</div>
        </div>
    )
}

function Bars({ title, rows }) {
    const max = Math.max(1, ...rows.map((r) => r.value))
    return (
        <div style={card}>
            <h2 style={h2}>{title}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {rows.map((r) => (
                    <div key={r.label} style={{ display: 'grid', gridTemplateColumns: 'minmax(80px, 36%) 1fr auto', alignItems: 'center', gap: 8, fontSize: '0.72rem' }}>
                        <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.label}>{r.label}</span>
                        <span style={{ background: 'var(--subtle)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                            <span style={{ display: 'block', height: '100%', width: `${Math.max(2, (r.value / max) * 100)}%`, background: 'var(--accent)', borderRadius: 4 }} />
                        </span>
                        <span style={{ color: 'var(--bright)', fontWeight: 700, fontVariantNumeric: 'tabular-nums', minWidth: 40, textAlign: 'right' }}>{fmt(r.value)}</span>
                    </div>
                ))}
            </div>
        </div>
    )
}

// Two-segment split bar (tech vs product, India vs USA).
function Split({ title, parts, note }) {
    const total = parts.reduce((a, p) => a + p.value, 0)
    if (!total) return null
    return (
        <div style={card}>
            <h2 style={h2}>{title}</h2>
            <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', background: 'var(--subtle)' }} role="img"
                aria-label={parts.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', ')}>
                {parts.map((p, i) => (
                    <span key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: i === 0 ? 'var(--accent)' : 'var(--muted)' }} />
                ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.72rem', marginTop: 8, color: 'var(--muted)' }}>
                {parts.map((p) => (
                    <span key={p.label}><b style={{ color: 'var(--bright)' }}>{Math.round((p.value / total) * 100)}%</b> {p.label} · {fmt(p.value)}</span>
                ))}
            </div>
            {note && <div style={{ fontSize: '0.66rem', color: 'var(--faint)', marginTop: 6 }}>{note}</div>}
        </div>
    )
}

function Trend({ points }) {
    const W = 600, H = 90, P = 6
    const vals = points.map((p) => p.open)
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1
    const x = (i) => P + (i / (points.length - 1)) * (W - 2 * P)
    const y = (v) => H - P - ((v - lo) / span) * (H - 2 * P)
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.open).toFixed(1)}`).join(' ')
    return (
        <div style={card}>
            <h2 style={h2}>Open jobs, last {points.length} days</h2>
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="90" preserveAspectRatio="none" role="img"
                aria-label={`Open jobs from ${fmt(vals[0])} to ${fmt(vals[vals.length - 1])}`}>
                <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            </svg>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.66rem', color: 'var(--faint)', marginTop: 4 }}>
                <span>{points[0].date} · {fmt(vals[0])}</span>
                <span>{points[points.length - 1].date} · {fmt(vals[vals.length - 1])}</span>
            </div>
        </div>
    )
}

export default function MarketAnalytics() {
    const [country, setCountry] = useState('IN')
    const { data, isLoading, error, refetch } = useMarketAnalytics(country)

    const toggle = (
        <div className="profile-segment" role="group" aria-label="Country" style={{ maxWidth: 220 }}>
            {COUNTRIES.map(([k, label]) => (
                <button key={k} type="button" className={'profile-segment-btn' + (country === k ? ' is-active' : '')}
                    aria-pressed={country === k} onClick={() => setCountry(k)}>{label}</button>
            ))}
        </div>
    )

    if (isLoading) return <LoadingState label="Loading market data…" />
    if (error) return <ErrorState err={error} onRetry={refetch} />
    if (!data || !data.ready) {
        return (
            <>
                {toggle}
                <EmptyState title="Analytics are warming up" message="Market numbers appear after the next crawler pass." />
            </>
        )
    }

    const fam = (data.families || []).slice(0, 12).map((f) => ({
        label: f.label + (f.family === 'product' ? ' (product)' : ''), value: f.count }))
    const rs = Object.fromEntries((data.roleSplit || []).map((r) => [r.label, r.count]))
    const roleParts = [{ label: 'Tech', value: rs.tech || 0 }, { label: 'Product-associated', value: rs.product || 0 }]
    const cs = Object.fromEntries((data.countrySplit || []).map((r) => [r.label, r.count]))
    const countryParts = [{ label: 'India', value: cs.IN || 0 }, { label: 'USA', value: cs.US || 0 }]
    const days = data.windowDays || 15
    const sen = [...(data.seniority || [])]
        .sort((a, b) => SEN_ORDER.indexOf(a.label) - SEN_ORDER.indexOf(b.label))
        .map((s) => ({ label: SEN_LABEL[s.label] || s.label, value: s.count }))
    const types = (data.companyTypes || []).filter((t) => t.count > 0)
    const typeTotal = types.reduce((a, t) => a + t.count, 0)
    const trend = (data.trend || []).filter((p) => Number.isFinite(p.open))

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {toggle}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                <Stat label="Open jobs now" value={fmt(data.openNow)} />
                <Stat label="New in last 24h" value={fmt(data.new24h)} />
                <Stat label="Companies hiring" value={fmt(data.companies)} />
            </div>

            {trend.length >= 2 && <Trend points={trend} />}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
                <Split title={`Tech vs product (${COUNTRIES.find(([k]) => k === country)[1]})`} parts={roleParts} />
                <Split title="India vs USA (whole pool)" parts={countryParts} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
                <Bars title="Role categories" rows={fam} />
                <Bars title="Experience level" rows={sen} />
            </div>

            <div style={card}>
                <h2 style={h2}>Top hiring companies</h2>
                <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '6px 20px' }}>
                    {(data.topCompanies || []).map((c, i) => (
                        <li key={c.name} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: '0.74rem', minWidth: 0 }}>
                            <span style={{ color: 'var(--faint)', width: 16, textAlign: 'right' }}>{i + 1}</span>
                            <span style={{ color: 'var(--bright)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{c.name}</span>
                            <span style={{ color: 'var(--faint)', fontSize: '0.66rem' }}>{TYPE_LABEL[c.type] || ''}</span>
                            <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{fmt(c.count)}</span>
                        </li>
                    ))}
                </ol>
                {typeTotal > 0 && (
                    <div style={{ marginTop: 12, fontSize: '0.7rem', color: 'var(--muted)' }}>
                        {types.map((t) => `${TYPE_LABEL[t.label] || t.label} ${Math.round((t.count / typeTotal) * 100)}%`).join(' · ')}
                    </div>
                )}
            </div>

            <p style={{ fontSize: '0.66rem', color: 'var(--faint)', margin: 0 }}>
                Based on {fmt(data.openNow)} tech and product jobs posted in the last {days} days from {fmt(data.companies)} company career sites + LinkedIn.
            </p>
        </div>
    )
}

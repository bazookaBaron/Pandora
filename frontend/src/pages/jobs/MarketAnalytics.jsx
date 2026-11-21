import { useState } from 'react'
import { useMarketAnalytics } from '../../lib/useJobs'
import { LoadingState, ErrorState, EmptyState } from '../../components/shared/states'

// Jobs -> Analytics: numbers come from Adzuna's public job-market data,
// snapshotted daily by the server (lib/marketSnapshot.js). Plain CSS/SVG.
const ROLE_LABEL = {
    software_engineering: 'Software engineering', data_science_ml: 'Data science / ML', data_analyst: 'Data analyst',
    devops_cloud: 'DevOps / cloud', qa_testing: 'QA / testing', cyber_security: 'Cyber security',
    product_management: 'Product management', project_program_management: 'Project / program mgmt',
    business_analyst: 'Business analyst', sap_erp: 'SAP / ERP', ui_ux_design: 'UI / UX design', marketing: 'Marketing',
    sales_bd: 'Sales / biz dev', finance_accounting: 'Finance / accounting', hr_recruiting: 'HR / recruiting',
    operations_supply_chain: 'Operations / supply chain', customer_success_support: 'Customer success / support',
    consulting: 'Consulting', legal_compliance: 'Legal / compliance', content_communications: 'Content / comms',
}
const EXP_LABEL = { entry: 'Entry', mid: 'Mid', senior: 'Senior', leadership: 'Leadership' }
const COUNTRIES = [['IN', 'India'], ['US', 'USA']]

const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString() : '—')
const pct = (part, total) => (Number.isFinite(part) && total > 0 ? `${Math.round((part / total) * 100)}%` : '—')

const card = { background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '14px 16px', minWidth: 0 }
const h2 = { fontSize: '0.86rem', fontWeight: 900, color: 'var(--bright)', letterSpacing: '-0.01em', margin: '0 0 10px' }

function Stat({ label, value, sub }) {
    return (
        <div style={{ ...card, padding: '12px 14px' }}>
            <div style={{ fontSize: '1.45rem', fontWeight: 900, color: 'var(--bright)', letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
            <div style={{ fontSize: '0.66rem', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>{label}</div>
            {sub && <div style={{ fontSize: '0.66rem', color: 'var(--faint)', marginTop: 2 }}>{sub}</div>}
        </div>
    )
}

function Bars({ title, note, rows }) {
    const items = rows.filter((r) => Number.isFinite(r.value))
    const max = Math.max(1, ...items.map((r) => r.value))
    return (
        <div style={card}>
            <h2 style={h2}>{title}</h2>
            {note && <div style={{ fontSize: '0.66rem', color: 'var(--faint)', margin: '-6px 0 10px' }}>{note}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {items.map((r) => (
                    <div key={r.label} style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 38%) 1fr auto', alignItems: 'center', gap: 8, fontSize: '0.72rem' }}>
                        <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.label}>{r.label}</span>
                        <span style={{ background: 'var(--subtle)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                            <span style={{ display: 'block', height: '100%', width: `${Math.max(2, (r.value / max) * 100)}%`, background: 'var(--accent)', borderRadius: 4 }} />
                        </span>
                        <span style={{ color: 'var(--bright)', fontWeight: 700, fontVariantNumeric: 'tabular-nums', minWidth: 44, textAlign: 'right' }}>{fmt(r.value)}</span>
                    </div>
                ))}
            </div>
        </div>
    )
}

function Sparkline({ points }) {
    const W = 600, H = 90, P = 6
    const vals = points.map((p) => p.total)
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1
    const x = (i) => P + (i / (points.length - 1)) * (W - 2 * P)
    const y = (v) => H - P - ((v - lo) / span) * (H - 2 * P)
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.total).toFixed(1)}`).join(' ')
    return (
        <div style={card}>
            <h2 style={h2}>Open roles, last {points.length} days</h2>
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="90" preserveAspectRatio="none" role="img"
                aria-label={`Open roles from ${fmt(vals[0])} to ${fmt(vals[vals.length - 1])}`}>
                <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            </svg>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.66rem', color: 'var(--muted)', marginTop: 4 }}>
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {toggle}
                <EmptyState icon="📊" title="Market data is being prepared" message="Daily job-market numbers will appear here shortly." />
            </div>
        )
    }

    const s = data.snapshot
    const total = s.total
    const roles = Object.entries(s.roles || {}).map(([k, v]) => ({ label: ROLE_LABEL[k] || k, value: v })).sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
    const exp = Object.entries(s.experience || {}).map(([k, v]) => ({ label: EXP_LABEL[k] || k, value: v }))
    const cities = Object.entries(s.cities || {}).map(([label, value]) => ({ label, value })).sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
    const trend = data.trend || []

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {toggle}
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
                <Stat label="Open roles" value={fmt(total)} />
                <Stat label="New this week" value={fmt(s.new_7d)} sub={s.new_7d != null ? `${pct(s.new_7d, total)} of open` : undefined} />
                <Stat label="Remote" value={pct(s.work_mode?.remote, total)} sub={s.work_mode?.hybrid != null ? `Hybrid ${pct(s.work_mode.hybrid, total)}` : undefined} />
                <Stat label="Contract" value={pct(s.contract, total)} />
            </div>
            <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))' }}>
                <Bars title="Role families" note="Keyword-matched titles; a posting can match more than one." rows={roles} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
                    <Bars title="Experience level (approx.)" note="Estimated from title keywords, not a verified field." rows={exp} />
                    <Bars title="Top cities" rows={cities} />
                </div>
            </div>
            {trend.length >= 2 && <Sparkline points={trend} />}
            <div style={{ fontSize: '0.68rem', color: 'var(--faint)' }}>
                Source: Adzuna public job-market data, updated daily on {data.date}. Remote and hybrid are keyword matches; the remainder is mostly on-site.
            </div>
        </div>
    )
}

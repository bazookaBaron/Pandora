import { useState } from 'react'
import { BarChart3, Briefcase, Building2, Layers, Sparkles, TrendingUp, Trophy, Users } from 'lucide-react'
import { useMarketAnalytics } from '../../lib/useJobs'
import { LoadingState, ErrorState, EmptyState } from '../../components/shared/states'
import { SectionHead, Segmented, StackBar, StatTile, StatTiles } from '../../components/ui'
import { num } from '../../lib/format'

// Jobs -> Analytics: every number comes from our own crawler pool
// (server: /api/market/analytics). Plain CSS/SVG, theme tokens only.
const COUNTRIES = [{ value: 'IN', label: 'India' }, { value: 'US', label: 'USA' }]
const SEN_LABEL = { intern: 'Intern', junior: 'Junior', mid: 'Mid', senior: 'Senior', staff: 'Staff', principal: 'Principal', unknown: 'Not stated' }
const SEN_ORDER = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'unknown']
const TYPE_LABEL = { product: 'Product', service: 'Service', startup: 'Startup', unknown: 'Other' }

const fmt = (n) => (Number.isFinite(n) ? num(n) : '—')

function Card({ icon, title, tone = 'history', children }) {
    return (
        <div className="sys-card mkt-card">
            <SectionHead as="h3" icon={icon} title={title} tone={tone} />
            {children}
        </div>
    )
}

function Bars({ icon, title, rows, tone }) {
    const max = Math.max(1, ...rows.map((r) => r.value))
    return (
        <Card icon={icon} title={title} tone={tone}>
            <div className={`mkt-bars tone-${tone}`}>
                {rows.map((r) => (
                    <div key={r.label} className="mkt-bar-row">
                        <span className="mkt-bar-label" title={r.label}>{r.label}</span>
                        <span className="mkt-bar-track">
                            <span style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
                        </span>
                        <span className="mkt-bar-value">{fmt(r.value)}</span>
                    </div>
                ))}
            </div>
        </Card>
    )
}

// Two-part split bar (tech vs product, India vs USA).
function Split({ icon, title, parts, note }) {
    const total = parts.reduce((a, p) => a + p.value, 0)
    if (!total) return null
    return (
        <Card icon={icon} title={title} tone="active">
            <StackBar total={total} segments={parts.map((p, i) => ({ key: p.label, label: p.label, value: p.value, tone: i === 0 ? 'active' : 'plan' }))}
                label={parts.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', ')} />
            <div className="mkt-split-legend">
                {parts.map((p, i) => (
                    <span key={p.label} className={`tone-${i === 0 ? 'active' : 'plan'}`}>
                        <b className="tone-text">{Math.round((p.value / total) * 100)}%</b> {p.label} · {fmt(p.value)}
                    </span>
                ))}
            </div>
            {note && <div className="mkt-note">{note}</div>}
        </Card>
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
        <Card icon={TrendingUp} title={`Open jobs, last ${points.length} days`} tone="active">
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="90" preserveAspectRatio="none" role="img"
                aria-label={`Open jobs from ${fmt(vals[0])} to ${fmt(vals[vals.length - 1])}`}>
                <path d={d} fill="none" stroke="var(--sys-active)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            </svg>
            <div className="mkt-trend-foot">
                <span>{points[0].date} · {fmt(vals[0])}</span>
                <span>{points[points.length - 1].date} · {fmt(vals[vals.length - 1])}</span>
            </div>
        </Card>
    )
}

export default function MarketAnalytics() {
    const [country, setCountry] = useState('IN')
    const { data, isLoading, error, refetch } = useMarketAnalytics(country)

    const toggle = <Segmented label="Country" value={country} onChange={setCountry} options={COUNTRIES} />

    if (isLoading) return <LoadingState label="Loading market data…" />
    if (error) return <ErrorState err={error} onRetry={refetch} />
    if (!data || !data.ready) {
        return (
            <>
                {toggle}
                <EmptyState art="stats" title="Analytics are warming up" message="Market numbers appear after the next crawler pass." />
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
    const countryLabel = COUNTRIES.find((c) => c.value === country).label

    return (
        <div className="mkt">
            {toggle}
            <StatTiles cols={3}>
                <StatTile icon={Briefcase} label="Open jobs" value={data.openNow} tone="active" />
                <StatTile icon={Sparkles} label="New 24h" value={data.new24h} tone="success" />
                <StatTile icon={Building2} label="Companies" value={data.companies} tone="plan" />
            </StatTiles>

            {trend.length >= 2 && <Trend points={trend} />}

            <div className="mkt-grid">
                <Split icon={Layers} title={`Tech vs product (${countryLabel})`} parts={roleParts} />
                <Split icon={Users} title="India vs USA (whole pool)" parts={countryParts} />
            </div>

            <div className="mkt-grid">
                <Bars icon={BarChart3} title="Role categories" rows={fam} tone="active" />
                <Bars icon={Users} title="Experience level" rows={sen} tone="plan" />
            </div>

            <Card icon={Trophy} title="Top hiring companies" tone="attention">
                <ol className="mkt-top">
                    {(data.topCompanies || []).map((c, i) => (
                        <li key={c.name}>
                            <span className="mkt-top-rank">{i + 1}</span>
                            <span className="mkt-top-name">{c.name}</span>
                            <span className="mkt-top-type">{TYPE_LABEL[c.type] || ''}</span>
                            <span className="mkt-top-count">{fmt(c.count)}</span>
                        </li>
                    ))}
                </ol>
                {typeTotal > 0 && (
                    <div className="mkt-types">
                        {types.map((t) => `${TYPE_LABEL[t.label] || t.label} ${Math.round((t.count / typeTotal) * 100)}%`).join(' · ')}
                    </div>
                )}
            </Card>

            <p className="mkt-foot">
                Based on {fmt(data.openNow)} tech and product jobs posted in the last {days} days from {fmt(data.companies)} company career sites + LinkedIn.
            </p>
        </div>
    )
}

// Minimal, dependency-free renderer for the rare `chart_config` payload.
// If the config looks like a bar/line spec ({ type, data }) we hand-roll a
// small SVG; otherwise we show the raw JSON in a collapsible block.

function normalizeSeries(config) {
    const data = config?.data

    // Shape A: [{ label|name|x, value|y|count }, ...]
    if (Array.isArray(data)) {
        const points = data
            .map((d) => ({
                label: String(d.label ?? d.name ?? d.x ?? ''),
                value: Number(d.value ?? d.y ?? d.count),
            }))
            .filter((d) => Number.isFinite(d.value))
        return points.length ? points : null
    }

    // Shape B (Chart.js-like): { labels: [...], datasets: [{ data: [...] }] }
    if (data && Array.isArray(data.labels) && Array.isArray(data.datasets) && data.datasets[0]) {
        const values = data.datasets[0].data || []
        const points = data.labels
            .map((label, i) => ({ label: String(label), value: Number(values[i]) }))
            .filter((d) => Number.isFinite(d.value))
        return points.length ? points : null
    }

    return null
}

function JsonFallback({ config }) {
    return (
        <details style={{ margin: '12px 0', border: '1px solid var(--subtle)', borderRadius: 6, background: 'var(--surface-2)' }}>
            <summary style={{ cursor: 'pointer', padding: '8px 12px', fontSize: '0.62rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--faint)' }}>
                Chart data
            </summary>
            <pre style={{ margin: 0, padding: '10px 12px', overflowX: 'auto', fontSize: '0.72rem', lineHeight: 1.6, color: 'var(--accent)' }}>
                {JSON.stringify(config, null, 2)}
            </pre>
        </details>
    )
}

export default function ChartBlock({ config }) {
    if (!config) return null

    const type = typeof config.type === 'string' ? config.type.toLowerCase() : null
    const isChartType = type === 'bar' || type === 'column' || type === 'line'
    const series = isChartType ? normalizeSeries(config) : null

    if (!series) return <JsonFallback config={config} />

    const W = 520, H = 220, padL = 40, padR = 12, padT = 12, padB = 40
    const plotW = W - padL - padR
    const plotH = H - padT - padB
    const max = Math.max(...series.map((d) => d.value), 0)
    const min = Math.min(...series.map((d) => d.value), 0)
    const range = max - min || 1
    const y = (v) => padT + plotH - ((v - min) / range) * plotH
    const step = plotW / series.length
    const isLine = type === 'line'
    const title = typeof config.title === 'string' ? config.title : null

    return (
        <figure style={{ margin: '12px 0' }}>
            {title && (
                <figcaption style={{ fontSize: '0.62rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--faint)', marginBottom: 6 }}>
                    {title}
                </figcaption>
            )}
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={title || `${type} chart`}
                style={{ background: 'var(--surface-2)', border: '1px solid var(--subtle)', borderRadius: 6 }}>
                <line x1={padL} y1={y(0)} x2={W - padR} y2={y(0)} stroke="#27272a" strokeWidth="1" />

                {isLine ? (
                    <polyline fill="none" stroke="#22d3ee" strokeWidth="2"
                        points={series.map((d, i) => `${padL + step * i + step / 2},${y(d.value)}`).join(' ')} />
                ) : (
                    series.map((d, i) => {
                        const bw = Math.max(2, step * 0.6)
                        const bx = padL + step * i + (step - bw) / 2
                        const by = Math.min(y(d.value), y(0))
                        const bh = Math.abs(y(d.value) - y(0))
                        return <rect key={i} x={bx} y={by} width={bw} height={bh} fill="#22d3ee" rx="1" />
                    })
                )}

                {isLine && series.map((d, i) => (
                    <circle key={i} cx={padL + step * i + step / 2} cy={y(d.value)} r="3" fill="#22d3ee" />
                ))}

                {series.map((d, i) => (
                    <text key={i} x={padL + step * i + step / 2} y={H - padB + 14} textAnchor="middle" fontSize="9" fill="#71717a">
                        {d.label.length > 8 ? `${d.label.slice(0, 7)}…` : d.label}
                    </text>
                ))}

                <text x={padL - 6} y={y(max)} textAnchor="end" fontSize="9" fill="#71717a" dominantBaseline="middle">{max}</text>
                <text x={padL - 6} y={y(min)} textAnchor="end" fontSize="9" fill="#71717a" dominantBaseline="middle">{min}</text>
            </svg>
        </figure>
    )
}

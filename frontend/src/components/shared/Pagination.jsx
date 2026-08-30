// Shared list pagination — extracted from the LLD panel so LLD and HLD render
// the exact same control (page-size, page-number UI, prev/next, styling).
// `accent` defaults to the LLD pink; pass another token/hex to re-tint.
export default function Pagination({ page, totalPages, onChange, accent = '#f472b6' }) {
    if (totalPages <= 1) return null
    const pages = []
    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= page - 1 && i <= page + 1)) {
            pages.push(i)
        } else if (pages[pages.length - 1] !== '…') {
            pages.push('…')
        }
    }
    return (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'center', marginTop: 24 }}>
            <button
                onClick={() => onChange(page - 1)}
                disabled={page === 1}
                style={{
                    padding: '5px 12px', borderRadius: 6, border: '1px solid var(--subtle)',
                    background: 'none', color: page === 1 ? 'var(--subtle-strong)' : 'var(--accent)', cursor: page === 1 ? 'default' : 'pointer',
                    fontSize: '0.78rem',
                }}
            >← Prev</button>
            {pages.map((p, idx) => (
                p === '…' ? (
                    <span key={`e${idx}`} style={{ color: 'var(--faint)', fontSize: '0.78rem', padding: '0 4px' }}>…</span>
                ) : (
                    <button
                        key={p}
                        onClick={() => onChange(p)}
                        style={{
                            width: 32, height: 32, borderRadius: 6, border: `1px solid ${p === page ? accent : 'var(--subtle)'}`,
                            background: p === page ? `${accent}1f` : 'none',
                            color: p === page ? accent : 'var(--muted)', cursor: 'pointer', fontSize: '0.78rem', fontWeight: p === page ? 900 : 400,
                        }}
                    >{p}</button>
                )
            ))}
            <button
                onClick={() => onChange(page + 1)}
                disabled={page === totalPages}
                style={{
                    padding: '5px 12px', borderRadius: 6, border: '1px solid var(--subtle)',
                    background: 'none', color: page === totalPages ? 'var(--subtle-strong)' : 'var(--accent)', cursor: page === totalPages ? 'default' : 'pointer',
                    fontSize: '0.78rem',
                }}
            >Next →</button>
        </div>
    )
}

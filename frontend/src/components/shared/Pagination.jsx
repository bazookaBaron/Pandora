import { ChevronLeft, ChevronRight } from 'lucide-react'

// Shared list pagination (LLD, HLD, DSA, Jobs, …). Styles: .sys-pager* in styles/system.css
// (32px buttons on desktop, 40px on phones; Prev/Next collapse to arrows on phones).
//
//   <Pagination page={page} totalPages={pages} onChange={setPage} />
//   <Pagination page={page} totalPages={pages} onChange={setPage} accent="var(--sys-plan)" label="HLD pages" />
//
// `accent` tints the current page; any CSS colour or token. The default is the LLD
// pink token (var(--warm)), the same colour the old hard-coded default rendered in dark mode.
export default function Pagination({ page, totalPages, onChange, accent = 'var(--warm)', label = 'Pagination' }) {
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
        <nav className="sys-pager" aria-label={label} style={{ '--pager-accent': accent }}>
            <button
                type="button"
                className="sys-pager-btn is-step"
                onClick={() => onChange(page - 1)}
                disabled={page === 1}
                aria-label="Previous page"
            >
                <ChevronLeft size={14} aria-hidden="true" /><span className="sys-pager-word">Prev</span>
            </button>
            {pages.map((p, idx) => (
                p === '…' ? (
                    <span key={`e${idx}`} className="sys-pager-gap" aria-hidden="true">…</span>
                ) : (
                    <button
                        key={p}
                        type="button"
                        className="sys-pager-btn"
                        onClick={() => onChange(p)}
                        aria-current={p === page ? 'page' : undefined}
                        aria-label={`Page ${p}`}
                    >{p}</button>
                )
            ))}
            <button
                type="button"
                className="sys-pager-btn is-step"
                onClick={() => onChange(page + 1)}
                disabled={page === totalPages}
                aria-label="Next page"
            >
                <span className="sys-pager-word">Next</span><ChevronRight size={14} aria-hidden="true" />
            </button>
        </nav>
    )
}

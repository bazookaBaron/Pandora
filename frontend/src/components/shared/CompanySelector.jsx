import { useState, useRef, useEffect } from 'react'
import { useCompanies } from '../../lib/useCompanies'

// Searchable multi-select combobox for companies
// Props: selected (string[]), onChange(string[])
export default function CompanySelector({ selected = [], onChange }) {
    const [open, setOpen] = useState(false)
    const [search, setSearch] = useState('')
    const { data: companies = [], isLoading } = useCompanies()
    const ref = useRef(null)

    // Close on outside click
    useEffect(() => {
        const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [])

    const filtered = companies.filter(c =>
        c.toLowerCase().includes(search.toLowerCase()) && !selected.includes(c)
    )

    const add = (company) => { onChange([...selected, company]); setSearch('') }
    const remove = (company) => onChange(selected.filter(c => c !== company))
    const clear = () => { onChange([]); setSearch('') }

    return (
        <div ref={ref} className="co-sel" style={{ position: 'relative', minWidth: 0 }}>
            {/* Trigger box */}
            <div
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 4,
                    padding: '6px 10px',
                    background: 'var(--panel)',
                    border: `1px solid ${open ? 'var(--pop)' : 'var(--subtle)'}`,
                    borderRadius: 6,
                    cursor: 'text',
                    minHeight: 44,
                    alignItems: 'center',
                    boxShadow: open ? '0 0 0 2px color-mix(in srgb, var(--pop) 15%, transparent)' : 'none',
                    transition: 'border-color 0.15s, box-shadow 0.15s',
                }}
                onClick={() => { setOpen(true); }}
            >
                {selected.length === 0 && !open && (
                    <span style={{ color: 'var(--muted)', fontSize: '0.9375rem' }}>Search company…</span>
                )}
                {selected.map(c => (
                    <span key={c} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        background: 'var(--pop-dim)', color: 'var(--pop)',
                        border: '1px solid color-mix(in srgb, var(--pop) 25%, transparent)', borderRadius: 4,
                        padding: '1px 6px', fontSize: '0.8125rem', fontWeight: 600,
                    }}>
                        {c}
                        <button type="button" aria-label={`Remove ${c}`}
                            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation() }}
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); remove(c) }}
                            style={{ background: 'none', border: 'none', color: 'var(--pop)', cursor: 'pointer', padding: '4px 6px', margin: '-4px -6px -4px 0', lineHeight: 1, fontSize: 14, minWidth: 24, minHeight: 24, touchAction: 'manipulation' }}>
                            ×
                        </button>
                    </span>
                ))}
                {open && (
                    <input
                        autoFocus
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder={selected.length ? '' : 'Search company…'}
                        aria-label="Search company"
                        role="combobox"
                        aria-expanded={open}
                        aria-autocomplete="list"
                        style={{
                            background: 'none', border: 'none', outline: 'none', color: 'var(--bright)',
                            font: 'inherit', fontSize: '1rem', minWidth: 80, flex: 1,
                        }}
                        onKeyDown={e => {
                            if (e.key === 'Escape') setOpen(false)
                            if (e.key === 'Enter' && filtered[0]) { e.preventDefault(); add(filtered[0]) }
                            if (e.key === 'Backspace' && !search && selected.length) {
                                remove(selected[selected.length - 1])
                            }
                        }}
                    />
                )}
                {selected.length > 0 && (
                    <button type="button" aria-label="Clear all companies" onClick={(e) => { e.preventDefault(); e.stopPropagation(); clear() }}
                        title="Clear all"
                        style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 16, marginLeft: 'auto', padding: 0, minWidth: 32, minHeight: 32 }}>
                        ×
                    </button>
                )}
            </div>

            {/* Dropdown */}
            {open && (
                <div role="listbox" aria-label="Companies" style={{
                    position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
                    background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 6,
                    maxHeight: 240, overflowY: 'auto', zIndex: 200,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                }}>
                    {isLoading && (
                        <div style={{ padding: '8px 12px', color: 'var(--muted)', fontSize: '0.8rem' }}>Loading…</div>
                    )}
                    {!isLoading && filtered.length === 0 && (
                        <div style={{ padding: '8px 12px', color: 'var(--muted)', fontSize: '0.8rem' }}>
                            {search ? 'No match' : 'All companies selected'}
                        </div>
                    )}
                    {filtered.map(c => (
                        <div key={c}
                            role="option"
                            aria-selected="false"
                            onMouseDown={(e) => { e.preventDefault(); add(c) }}
                            style={{
                                display: 'flex', alignItems: 'center', minHeight: 44,
                                padding: '0 12px', cursor: 'pointer', fontSize: '0.9375rem', color: 'var(--accent)',
                                borderBottom: '1px solid var(--subtle)',
                                transition: 'background 0.1s, color 0.1s',
                            }}
                            onMouseEnter={e => { e.target.style.background = 'var(--subtle)'; e.target.style.color = 'var(--bright)' }}
                            onMouseLeave={e => { e.target.style.background = 'none'; e.target.style.color = 'var(--accent)' }}
                        >
                            {c}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

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
        <div ref={ref} style={{ position: 'relative', minWidth: 180 }}>
            {/* Trigger box */}
            <div
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 4,
                    padding: '6px 10px',
                    background: 'var(--panel)',
                    border: `1px solid ${open ? '#22d3ee' : 'var(--subtle)'}`,
                    borderRadius: 6,
                    cursor: 'text',
                    minHeight: 36,
                    alignItems: 'center',
                    boxShadow: open ? '0 0 0 2px rgba(34,211,238,0.15)' : 'none',
                    transition: 'border-color 0.15s, box-shadow 0.15s',
                }}
                onClick={() => { setOpen(true); }}
            >
                {selected.length === 0 && !open && (
                    <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>Company…</span>
                )}
                {selected.map(c => (
                    <span key={c} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        background: 'rgba(34,211,238,0.1)', color: '#22d3ee',
                        border: '1px solid rgba(34,211,238,0.25)', borderRadius: 4,
                        padding: '1px 6px', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase',
                    }}>
                        {c}
                        <button onClick={(e) => { e.stopPropagation(); remove(c) }}
                            style={{ background: 'none', border: 'none', color: '#22d3ee', cursor: 'pointer', padding: 0, lineHeight: 1, fontSize: 12 }}>
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
                        style={{
                            background: 'none', border: 'none', outline: 'none', color: 'var(--bright)',
                            font: 'inherit', fontSize: '0.8rem', minWidth: 80, flex: 1,
                        }}
                        onKeyDown={e => {
                            if (e.key === 'Escape') setOpen(false)
                            if (e.key === 'Backspace' && !search && selected.length) {
                                remove(selected[selected.length - 1])
                            }
                        }}
                    />
                )}
                {selected.length > 0 && (
                    <button onClick={(e) => { e.stopPropagation(); clear() }}
                        title="Clear all"
                        style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, marginLeft: 'auto', padding: '0 2px' }}>
                        ×
                    </button>
                )}
            </div>

            {/* Dropdown */}
            {open && (
                <div style={{
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
                            onMouseDown={(e) => { e.preventDefault(); add(c) }}
                            style={{
                                padding: '7px 12px', cursor: 'pointer', fontSize: '0.82rem', color: 'var(--accent)',
                                borderBottom: '1px solid rgba(39,39,42,0.5)',
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

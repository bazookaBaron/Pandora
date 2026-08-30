import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/apiClient'

export default function CommandPalette() {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [results, setResults] = useState([])
    const [loading, setLoading] = useState(false)
    const [selected, setSelected] = useState(0)
    const inputRef = useRef(null)
    const navigate = useNavigate()

    // Cmd+K / Ctrl+K to open
    useEffect(() => {
        const handler = (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault()
                setOpen(v => !v)
                setQuery('')
                setResults([])
                setSelected(0)
            }
            if (e.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [])

    // Focus input when opened
    useEffect(() => {
        if (open) setTimeout(() => inputRef.current?.focus(), 50)
    }, [open])

    // Search via the authenticated catalog endpoint — tier caps are enforced
    // server-side, so a free user's search never surfaces a capped-out problem.
    useEffect(() => {
        if (!query.trim()) { setResults([]); return }
        const t = setTimeout(async () => {
            setLoading(true)
            try {
                const data = await apiFetch(
                    '/api/catalog/search?limit=6&q=' + encodeURIComponent(query),
                )
                const dsaItems = (data?.dsa || []).map(r => ({ ...r, type: 'dsa' }))
                const lldItems = (data?.lld || []).map(r => ({ ...r, type: 'lld' }))
                setResults([...dsaItems, ...lldItems])
            } catch {
                setResults([])
            } finally {
                setSelected(0)
                setLoading(false)
            }
        }, 200)
        return () => clearTimeout(t)
    }, [query])

    const go = useCallback((item) => {
        if (item.type === 'dsa') {
            window.open(item.link, '_blank', 'noopener')
        } else {
            navigate(`/lld/${item.slug}`)
        }
        setOpen(false)
        setQuery('')
    }, [navigate])

    // Keyboard navigation in results
    const handleKeyDown = (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, results.length - 1)) }
        if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)) }
        if (e.key === 'Enter' && results[selected]) go(results[selected])
    }

    if (!open) return null

    return (
        <div
            style={{
                position: 'fixed', inset: 0, background: 'rgba(9,9,11,0.85)', backdropFilter: 'blur(6px)',
                zIndex: 500, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 120,
            }}
            onClick={e => { if (e.target === e.currentTarget) setOpen(false) }}
        >
            <div style={{
                width: '100%', maxWidth: 540, background: '#18181b', border: '1px solid #27272a',
                borderRadius: 10, overflow: 'hidden', boxShadow: '0 24px 60px rgba(0,0,0,0.7)',
            }}>
                {/* Search input */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid #27272a' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                    </svg>
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Search DSA + LLD problems…"
                        style={{
                            flex: 1, background: 'none', border: 'none', outline: 'none', color: '#fafafa',
                            font: 'inherit', fontSize: '0.9rem',
                        }}
                    />
                    <kbd style={{ fontSize: '0.65rem', color: '#71717a', border: '1px solid #3f3f46', borderRadius: 4, padding: '2px 6px' }}>ESC</kbd>
                </div>

                {/* Results */}
                <div style={{ maxHeight: 340, overflowY: 'auto' }}>
                    {loading && (
                        <div style={{ padding: 16, color: '#71717a', fontSize: '0.82rem', textAlign: 'center' }}>Searching…</div>
                    )}
                    {!loading && query && results.length === 0 && (
                        <div style={{ padding: 16, color: '#71717a', fontSize: '0.82rem', textAlign: 'center' }}>No results for "{query}"</div>
                    )}
                    {!query && (
                        <div style={{ padding: 16, color: '#52525b', fontSize: '0.78rem', textAlign: 'center' }}>
                            Type to search across all DSA &amp; LLD problems
                        </div>
                    )}
                    {results.map((item, i) => (
                        <div
                            key={item.id}
                            onMouseEnter={() => setSelected(i)}
                            onClick={() => go(item)}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 12,
                                padding: '10px 16px', cursor: 'pointer',
                                background: i === selected ? '#27272a' : 'transparent',
                                borderBottom: '1px solid rgba(39,39,42,0.5)',
                                transition: 'background 0.1s',
                            }}
                        >
                            <span style={{
                                fontSize: '0.6rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em',
                                padding: '2px 6px', borderRadius: 4,
                                background: item.type === 'dsa' ? 'rgba(34,211,238,0.1)' : 'rgba(244,114,182,0.1)',
                                color: item.type === 'dsa' ? '#22d3ee' : '#f472b6',
                                border: `1px solid ${item.type === 'dsa' ? 'rgba(34,211,238,0.2)' : 'rgba(244,114,182,0.2)'}`,
                                flexShrink: 0,
                            }}>
                                {item.type}
                            </span>
                            <span style={{ color: '#fafafa', fontSize: '0.88rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
                            {item.difficulty && (
                                <span style={{
                                    fontSize: '0.65rem', fontWeight: 700, color: item.difficulty === 'Easy' ? '#4ade80' : item.difficulty === 'Medium' ? '#facc15' : '#f87171',
                                    flexShrink: 0,
                                }}>{item.difficulty}</span>
                            )}
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#52525b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                <path d="M5 12h14M12 5l7 7-7 7" />
                            </svg>
                        </div>
                    ))}
                </div>

                {/* Footer */}
                <div style={{ padding: '8px 16px', borderTop: '1px solid #27272a', display: 'flex', gap: 16, color: '#52525b', fontSize: '0.65rem' }}>
                    <span><kbd style={{ fontSize: '0.65rem', border: '1px solid #3f3f46', borderRadius: 3, padding: '1px 5px', color: '#71717a' }}>↑↓</kbd> navigate</span>
                    <span><kbd style={{ fontSize: '0.65rem', border: '1px solid #3f3f46', borderRadius: 3, padding: '1px 5px', color: '#71717a' }}>↵</kbd> open</span>
                    <span><kbd style={{ fontSize: '0.65rem', border: '1px solid #3f3f46', borderRadius: 3, padding: '1px 5px', color: '#71717a' }}>ESC</kbd> close</span>
                </div>
            </div>
        </div>
    )
}

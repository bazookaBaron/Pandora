import { forwardRef } from 'react'
import { Search, X } from 'lucide-react'

/**
 * Search field: magnifier icon, labelled input (type=search, 40px tall), clear button, :focus-visible ring.
 * Controlled; `onChange` receives the STRING value (not the event).
 *
 *   <SearchInput label="Search problems" placeholder="Two sum, graphs…" value={q} onChange={setQ} />
 *   <SearchInput label="Search HLD" value={q} onChange={setQ} tone="plan" onEnter={submit} style={{ maxWidth: 360 }} />
 *
 * label: accessible name (required; visually hidden)   onClear: called after clearing (default: onChange(''))
 * tone: focus-ring colour (default active)              onEnter: called with the value on Enter
 * className / style go on the wrapper; any other prop (id, name, autoFocus, maxLength, …) goes on the <input>.
 */
const SearchInput = forwardRef(function SearchInput(
    { value = '', onChange, onClear, onEnter, label, placeholder = 'Search…', tone, className = '', style, ...inputProps },
    ref,
) {
    const has = String(value || '').length > 0
    return (
        <div className={`sys-search${tone ? ` tone-${tone}` : ''} ${className}`.trim()} style={style}>
            <Search size={15} className="sys-search-icon" aria-hidden="true" />
            <input
                ref={ref}
                type="search"
                enterKeyHint="search"
                autoComplete="off"
                spellCheck={false}
                className="sys-search-input"
                aria-label={label || placeholder}
                placeholder={placeholder}
                value={value}
                onChange={(e) => onChange?.(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(e.currentTarget.value) }
                    if (e.key === 'Escape' && has) { e.preventDefault(); onChange?.(''); onClear?.() }
                }}
                {...inputProps}
            />
            {has && (
                <button type="button" className="sys-search-clear" aria-label="Clear search" onClick={() => { onChange?.(''); onClear?.() }}>
                    <X size={14} aria-hidden="true" />
                </button>
            )}
        </div>
    )
})

export default SearchInput

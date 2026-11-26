import { useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useJobFacet } from '../../lib/useJobs'

// Result-aware autocomplete: suggestions come from /api/jobs/facets, which only
// returns company / location values that occur in the current open job set, fuzzy
// -ranked against what's typed. Free text still works — Enter applies it as-is.
// `multiple`: `value` is a string[] of picked values, rendered as removable chips.
export default function FacetCombobox({ field, value, onChange, placeholder, label, className = '', multiple = false }) {
    const selected = multiple ? (Array.isArray(value) ? value : []) : []
    const [text, setText] = useState(multiple ? '' : (value || ''))
    const [open, setOpen] = useState(false)
    const [q, setQ] = useState('')
    const boxRef = useRef(null)
    const listId = `${useId()}-list`

    useEffect(() => { if (!multiple) setText(value || '') }, [value, multiple])
    // Debounce the suggestion query; for single-select, also apply free text live.
    useEffect(() => {
        const t = setTimeout(() => {
            setQ(text.trim())
            if (!multiple) onChange(text.trim())
        }, 250)
        return () => clearTimeout(t)
    }, [text]) // eslint-disable-line react-hooks/exhaustive-deps

    const { options } = useJobFacet(field, q, open)
    const shown = multiple
        ? options.filter((o) => !selected.some((s) => s.toLowerCase() === o.toLowerCase()))
        : options

    useEffect(() => {
        if (!open) return
        const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
        document.addEventListener('mousedown', onDoc)
        return () => document.removeEventListener('mousedown', onDoc)
    }, [open])

    const commit = (v) => {
        if (multiple) {
            const val = (v || '').trim()
            if (val && !selected.some((s) => s.toLowerCase() === val.toLowerCase())) onChange([...selected, val])
            setText(''); setOpen(false)
            return
        }
        setText(v); onChange(v); setOpen(false)
    }
    const removeChip = (chip) => onChange(selected.filter((s) => s !== chip))
    const showList = open && shown.length > 0

    return (
        <div ref={boxRef} className={`sys-ac jobs-fc${text ? ' has-text' : ''} ${className}`.trim()}>
            {multiple && selected.length > 0 && (
                <div className="sys-chips">
                    {selected.map((chip) => (
                        <span key={chip} className="sys-chip">
                            <span className="sys-chip-text">{chip}</span>
                            <button type="button" aria-label={`Remove ${chip}`} onClick={() => removeChip(chip)}>
                                <X size={12} aria-hidden="true" />
                            </button>
                        </span>
                    ))}
                </div>
            )}
            <input
                className="input-field"
                placeholder={multiple && selected.length ? 'Add another…' : placeholder}
                aria-label={label || placeholder}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={showList}
                aria-controls={listId}
                autoComplete="off"
                value={text}
                onChange={(e) => { setText(e.target.value); setOpen(true) }}
                onFocus={() => setOpen(true)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') commit(multiple ? text : text.trim())
                    else if (e.key === 'Escape') setOpen(false)
                    else if (e.key === 'Backspace' && multiple && !text && selected.length) removeChip(selected[selected.length - 1])
                }}
            />
            {text && (
                <button type="button" aria-label="Clear" className="jobs-fc-clear" onMouseDown={(e) => e.preventDefault()}
                    onClick={() => (multiple ? (setText(''), setOpen(false)) : commit(''))}>
                    <X size={14} aria-hidden="true" />
                </button>
            )}
            {showList && (
                <ul id={listId} role="listbox" className="sys-ac-list">
                    {shown.map((o) => (
                        <li key={o} role="option" aria-selected={false} className="sys-ac-opt"
                            onMouseDown={(e) => { e.preventDefault(); commit(o) }}>
                            {o}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}

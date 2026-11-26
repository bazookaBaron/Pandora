import { useEffect, useId, useRef, useState } from 'react'
import { useCompanyOptions } from '../../lib/useReferrals'

/**
 * Company name input with server suggestions (free text allowed). Shared by Profile and Referrals
 * (was copied in both). AuthPage keeps its own copy on purpose.
 *
 *   <CompanyAutocomplete value={company} onChange={setCompany} />
 *   <CompanyAutocomplete id="ref-company" value={c} onChange={setC} placeholder="e.g. Google" required />
 *
 * Props: value, onChange(string), placeholder, id (for an external <label htmlFor>), required,
 *        'aria-label' (when there is no visible label), maxHeight (list height, default 220), disabled.
 * a11y: role=combobox + listbox; ArrowDown/ArrowUp move, Enter picks, Escape closes.
 * Suggestions are debounced 200ms and come from useCompanyOptions (lib/useReferrals).
 */
export default function CompanyAutocomplete({
    value, onChange, placeholder = 'Start typing a company…', id, required = false, maxHeight = 220, disabled = false,
    'aria-label': ariaLabel,
}) {
    const [open, setOpen] = useState(false)
    const [active, setActive] = useState(-1)
    const [debounced, setDebounced] = useState(value || '')
    const boxRef = useRef(null)
    const autoId = useId()
    const listId = `${id || autoId}-list`

    useEffect(() => {
        const t = setTimeout(() => setDebounced(value || ''), 200)
        return () => clearTimeout(t)
    }, [value])

    useEffect(() => {
        const onDoc = (e) => {
            if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDoc)
        return () => document.removeEventListener('mousedown', onDoc)
    }, [])

    const { data } = useCompanyOptions(debounced)
    const typed = (value || '').trim().toLowerCase()
    const options = (data?.companies || []).filter((c) => c.toLowerCase() !== typed)
    const showList = open && options.length > 0

    function pick(c) {
        onChange(c)
        setOpen(false)
        setActive(-1)
    }

    function onKeyDown(e) {
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
            setActive((i) => Math.min(options.length - 1, i + 1))
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => Math.max(-1, i - 1))
        } else if (e.key === 'Enter' && showList && active >= 0 && options[active]) {
            e.preventDefault()
            pick(options[active])
        } else if (e.key === 'Escape' && open) {
            e.preventDefault()
            setOpen(false)
            setActive(-1)
        }
    }

    return (
        <div ref={boxRef} className="sys-ac">
            <input
                id={id}
                type="text"
                className="input-field"
                autoComplete="off"
                placeholder={placeholder}
                value={value}
                required={required}
                disabled={disabled}
                aria-label={ariaLabel}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={showList}
                aria-controls={listId}
                aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
                onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(-1) }}
                onFocus={() => setOpen(true)}
                onKeyDown={onKeyDown}
            />
            {showList && (
                <ul id={listId} role="listbox" className="sys-ac-list" style={{ maxHeight }}>
                    {options.map((c, i) => (
                        <li
                            key={c}
                            id={`${listId}-${i}`}
                            role="option"
                            aria-selected={i === active}
                            className="sys-ac-opt"
                            onMouseDown={(e) => { e.preventDefault(); pick(c) }}
                            onMouseEnter={() => setActive(i)}
                        >
                            {c}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}

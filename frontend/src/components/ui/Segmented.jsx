import { useRef } from 'react'
import { nextIndex } from './rovingKeys'

/**
 * Segmented control: role=radiogroup with role=radio buttons, roving tabindex, arrow keys move + select.
 * Use for 2-5 mutually exclusive filters or settings (status filter, billing period, yes/no).
 *
 *   <Segmented label="Status" value={status} onChange={setStatus} options={[
 *       { value: 'all', label: 'All', count: 300 },
 *       { value: 'solved', label: 'Solved', count: 42, tone: 'success' },
 *       { value: 'todo', label: 'To do', icon: Circle },
 *   ]} />
 *
 * options[]: { value, label, count?, icon?, tone?, disabled? }   (tone tints the selected segment; default active)
 * label: aria-label of the group (required)   block: segments share the full width
 */
export default function Segmented({ options = [], value, onChange, label, block = false, className = '', ...rest }) {
    const refs = useRef([])
    const found = options.findIndex((o) => o.value === value)
    const current = found < 0 ? 0 : found
    function onKeyDown(e) {
        const i = nextIndex(e.key, current, options)
        if (i < 0) return
        e.preventDefault()
        onChange?.(options[i].value)
        refs.current[i]?.focus()
    }
    return (
        <div role="radiogroup" aria-label={label} className={`sys-segmented${block ? ' is-block' : ''} ${className}`.trim()} onKeyDown={onKeyDown} {...rest}>
            {options.map((o, i) => {
                const checked = o.value === value
                const Icon = o.icon
                return (
                    <button
                        key={String(o.value)}
                        ref={(el) => { refs.current[i] = el }}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        tabIndex={i === current ? 0 : -1}
                        disabled={o.disabled}
                        className={o.tone ? `tone-${o.tone}` : undefined}
                        onClick={() => onChange?.(o.value)}
                    >
                        {Icon && <Icon size={13} aria-hidden="true" />}
                        {o.label}
                        {o.count != null && <span className="sys-seg-count">{o.count}</span>}
                    </button>
                )
            })}
        </div>
    )
}

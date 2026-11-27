import { ChevronDown } from 'lucide-react'
import FluidCheckbox from '../shared/FluidCheckbox'
import { DIFFICULTY_TONE } from '../shared/DifficultyBadge'
import { Row } from '../ui'

// Shared pieces for the Prepare lists (DSA, Low-level design, System design).

/** Small coloured dot for a difficulty (Easy / Medium / Hard), with a text label for screen readers. */
export function DiffDot({ difficulty }) {
    if (!difficulty) return null
    const tone = DIFFICULTY_TONE[difficulty]
    return (
        <span className={`pr-dot${tone ? ` tone-${tone}` : ''}`} role="img" aria-label={difficulty} title={difficulty} />
    )
}

/**
 * One-line list row with a solved checkbox OUTSIDE the link (44px hit area),
 * so the checkbox and the row link are never nested.
 *   <CheckRow checked={solved} onToggle={…} title="Two sum" difficulty="Easy" href={url} target="_blank" />
 */
export function CheckRow({ checked, onToggle, checkLabel, extra, difficulty, meta, className = '', ...rowProps }) {
    return (
        <li className={`pr-crow${checked ? ' is-done' : ''} ${className}`.trim()}>
            <span className="pr-check">
                <FluidCheckbox checked={!!checked} onChange={onToggle} label={checkLabel} />
            </span>
            <Row meta={meta ?? (difficulty ? <DiffDot difficulty={difficulty} /> : undefined)} {...rowProps} />
            {extra}
        </li>
    )
}

/**
 * Chip-styled native select (one tap opens the phone's own picker).
 * options: [{ value, label }]; value '' = "any".
 */
export function ChipSelect({ label, value, onChange, options, active, className = '' }) {
    return (
        <label className={`pr-chip${active ? ' is-on' : ''} ${className}`.trim()}>
            <span className="pr-sr">{label}</span>
            <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
                {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
            </select>
            <ChevronDown size={14} className="pr-chip-chev" aria-hidden="true" />
        </label>
    )
}

export const DIFFICULTY_OPTIONS = [
    { value: '', label: 'Any level' },
    { value: 'Easy', label: 'Easy' },
    { value: 'Medium', label: 'Medium' },
    { value: 'Hard', label: 'Hard' },
]

/** Value + options for a difficulty chip backed by a multi-value URL list. */
export function difficultyChip(list = []) {
    if (list.length <= 1) return { value: list[0] || '', options: DIFFICULTY_OPTIONS }
    return { value: '__multi', options: [...DIFFICULTY_OPTIONS, { value: '__multi', label: `${list.length} levels`, disabled: true }] }
}

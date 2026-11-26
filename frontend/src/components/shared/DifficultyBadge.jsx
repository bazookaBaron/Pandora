// Difficulty badge (Easy / Medium / Hard). Tokens via .sys-diff + .tone-* (styles/system.css):
// Easy = success, Medium = waiting, Hard = danger, anything else = neutral.
export const DIFFICULTY_TONE = { Easy: 'success', Medium: 'waiting', Hard: 'danger' }

export default function DifficultyBadge({ difficulty }) {
    const tone = DIFFICULTY_TONE[difficulty]
    return (
        <span className={`sys-diff${tone ? ` tone-${tone}` : ''}`}>
            {difficulty || '—'}
        </span>
    )
}

export default function DifficultyBadge({ difficulty }) {
    const styles = {
        Easy: { color: '#4ade80', background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.25)' },
        Medium: { color: '#facc15', background: 'rgba(250,204,21,0.1)', border: '1px solid rgba(250,204,21,0.25)' },
        Hard: { color: '#f87171', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)' },
    }
    const s = styles[difficulty] || { color: 'var(--accent)', background: 'rgba(161,161,170,0.1)', border: '1px solid rgba(161,161,170,0.2)' }
    return (
        <span style={{
            ...s,
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 6,
            fontSize: '0.65rem',
            fontWeight: 900,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            whiteSpace: 'nowrap',
        }}>
            {difficulty || '—'}
        </span>
    )
}

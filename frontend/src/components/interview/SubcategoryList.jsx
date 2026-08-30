import { categoryColor } from './categoryTheme'
import { ErrorState, EmptyState } from '../shared/states'

// Native-button reset so rows are keyboard- and screen-reader-accessible
// while keeping the plain-row look.
const ROW_RESET = {
    appearance: 'none', border: 0, background: 'none', font: 'inherit',
    textAlign: 'left', width: '100%', cursor: 'pointer', display: 'block',
}

// ── Subcategory list (left panel) ─────────────────────────────────
// Data is fetched once by InterviewPage and passed down as props.
export default function SubcategoryList({ pairs = [], isLoading, error, activeSubcategory, onSelect }) {
    // Group by category
    const grouped = {}
    for (const { category, subcategory } of pairs) {
        if (!grouped[category]) grouped[category] = []
        grouped[category].push(subcategory)
    }
    const categories = Object.keys(grouped).sort()

    if (isLoading) return (
        <div style={{ padding: 12 }}>
            {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} style={{ height: 30, background: '#18181b', borderRadius: 4, marginBottom: 5, animation: 'pulse 1.5s ease-in-out infinite', opacity: 1 - i * 0.1 }} />
            ))}
        </div>
    )
    if (error) return <ErrorState compact err={error} style={{ margin: 12 }} />
    if (!pairs.length) return (
        <EmptyState
            compact
            icon="📚"
            title="No topics found"
            message="You may need to sign in, or no interview questions are visible to your account yet."
        />
    )

    return (
        <div style={{ overflowY: 'auto', height: '100%', padding: '8px 0' }}>
            {categories.map(cat => {
                const hue = categoryColor(cat)
                return (
                <div key={cat}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 14px 4px' }}>
                        <span style={{ width: 3, height: 11, background: hue, borderRadius: 1, flexShrink: 0 }} />
                        <span style={{ fontSize: '0.6rem', fontWeight: 900, color: hue, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                            {cat}
                        </span>
                    </div>
                    {grouped[cat].map(sub => {
                        const isActive = sub === activeSubcategory
                        return (
                            <button
                                type="button"
                                key={sub}
                                onClick={() => onSelect(sub)}
                                style={{
                                    ...ROW_RESET,
                                    padding: '7px 14px',
                                    borderLeft: `2px solid ${isActive ? hue : 'transparent'}`,
                                    background: isActive ? `${hue}14` : 'transparent',
                                    color: isActive ? hue : '#71717a',
                                    fontSize: '0.8rem', fontWeight: isActive ? 700 : 400,
                                    transition: 'all 0.12s',
                                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                }}
                                onMouseEnter={e => { if (!isActive) { e.currentTarget.style.color = '#fafafa'; e.currentTarget.style.background = `${hue}0d` } }}
                                onMouseLeave={e => { if (!isActive) { e.currentTarget.style.color = '#71717a'; e.currentTarget.style.background = 'transparent' } }}
                            >
                                {sub}
                            </button>
                        )
                    })}
                </div>
                )
            })}
        </div>
    )
}

import { categoryTone } from './categoryTheme'
import { ErrorState, EmptyState } from '../shared/states'

// ── Subcategory list (left panel) ─────────────────────────────────
// Data is fetched once by InterviewPage and passed down as props.
// One compact row per subcategory (.iq-row); colour = the category tone.
export default function SubcategoryList({ pairs = [], isLoading, error, activeSubcategory, onSelect }) {
    // Group by category
    const grouped = {}
    for (const { category, subcategory } of pairs) {
        if (!grouped[category]) grouped[category] = []
        grouped[category].push(subcategory)
    }
    const categories = Object.keys(grouped).sort()

    if (isLoading) return (
        <div style={{ padding: 12 }} role="status" aria-label="Loading topics">
            {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} style={{ height: 30, background: 'var(--panel)', borderRadius: 4, marginBottom: 5, animation: 'pulse 1.5s ease-in-out infinite', opacity: 1 - i * 0.1 }} />
            ))}
        </div>
    )
    if (error) return <ErrorState compact err={error} style={{ margin: 12 }} />
    if (!pairs.length) return (
        <EmptyState
            compact
            art="questions"
            title="No topics found"
            message="Sign in, or check back later."
        />
    )

    return (
        <nav aria-label="Interview topics" style={{ overflowY: 'auto', height: '100%', padding: '4px 0 8px' }}>
            {categories.map(cat => (
                <div key={cat} className={`tone-${categoryTone(cat)}`}>
                    <h3 className="iq-cat">{cat}</h3>
                    {grouped[cat].map(sub => (
                        <button
                            type="button"
                            key={sub}
                            className="iq-row"
                            aria-current={sub === activeSubcategory ? 'true' : undefined}
                            onClick={() => onSelect(sub)}
                            title={sub}
                        >
                            <span className="iq-row-text">{sub}</span>
                        </button>
                    ))}
                </div>
            ))}
        </nav>
    )
}

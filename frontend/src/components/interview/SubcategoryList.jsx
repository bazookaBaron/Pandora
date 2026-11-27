import { categoryTone, categoryColor } from './categoryTheme'
import { ErrorState, EmptyState } from '../shared/states'
import { Row } from '../ui'

// ── Topic list (left panel / "Topics" tab) ─────────────────────────
// Data is fetched once by InterviewPage and passed down as props.
// Categories are small headings; each topic is one 56px Row whose left
// edge carries the category tone.
export default function SubcategoryList({ pairs = [], isLoading, error, activeSubcategory, onSelect }) {
    // Group by category
    const grouped = {}
    for (const { category, subcategory } of pairs) {
        if (!grouped[category]) grouped[category] = []
        grouped[category].push(subcategory)
    }
    const categories = Object.keys(grouped).sort()

    if (isLoading) return (
        <ul className="sys-rows iq-rows" role="status" aria-label="Loading topics">
            {Array.from({ length: 8 }).map((_, i) => (
                <li key={i} className="pr-skel"><i style={{ flex: 1 }} /></li>
            ))}
        </ul>
    )
    if (error) return <ErrorState compact err={error} style={{ margin: 12 }} />
    if (!pairs.length) return (
        <EmptyState
            compact
            art="questions"
            title="No topics yet"
            message="Sign in, or check back later."
        />
    )

    return (
        <nav aria-label="Interview topics" className="iq-scroll">
            {categories.map(cat => (
                <section key={cat} className={`iq-group tone-${categoryTone(cat)}`} aria-label={cat}>
                    <h2 className="iq-cat">{cat}</h2>
                    <ul className="sys-rows iq-rows">
                        {grouped[cat].map(sub => (
                            <li key={sub}>
                                <Row
                                    title={sub}
                                    tone={categoryColor(cat)}
                                    selected={sub === activeSubcategory}
                                    onClick={() => onSelect(sub)}
                                />
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
        </nav>
    )
}

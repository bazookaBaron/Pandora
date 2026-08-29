// ── Category-keyed accent colours ─────────────────────────────────────
// Editorial hue accents layered over the dark-mono UI. Backgrounds and
// body text are untouched elsewhere — these are used only for borders,
// small pills, active-row tints and heading rules.

// Explicit map for the known categories, drawn from the app palette
// (same hues HLD uses for its node types).
const CATEGORY_COLORS = {
    'Databases': '#4ade80',              // green
    'DevOps & Cloud': '#fb923c',         // orange
    'Frameworks': '#a78bfa',             // purple
    'Programming Languages': '#22d3ee',  // cyan / --pop
    'Tools': '#f472b6',                  // pink / --warm
}

// Deterministic fallback for data-driven categories not in the map.
// Same hash + palette the rest of the app uses (Navbar, ProfilePage, HLD).
const FALLBACK_PALETTE = ['#22d3ee', '#f472b6', '#4ade80', '#facc15', '#fb923c', '#a78bfa', '#60a5fa', '#34d399']

export function categoryColor(category = '') {
    if (CATEGORY_COLORS[category]) return CATEGORY_COLORS[category]
    let hash = 0
    for (let i = 0; i < category.length; i++) hash = category.charCodeAt(i) + ((hash << 5) - hash)
    return FALLBACK_PALETTE[Math.abs(hash) % FALLBACK_PALETTE.length]
}

// Resolve the hue for a subcategory given the (category, subcategory) pairs.
export function accentForSubcategory(pairs = [], subcategory = null) {
    if (!subcategory) return '#22d3ee'
    const pair = pairs.find(p => p.subcategory === subcategory)
    return categoryColor(pair ? pair.category : '')
}

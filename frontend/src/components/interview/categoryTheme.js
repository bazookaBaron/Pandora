// ── Category-keyed tones ───────────────────────────────────────────────
// Each interview category gets one brand colour, used only for borders,
// small pills, active-row tints and heading rules. Brand tokens only:
// pop (tone-active), warm (tone-attention), green (tone-success), via the
// .tone-* classes in styles/system.css, so light and dark both stay on brand.

const TONES = ['active', 'attention', 'success']

// Fixed tones for the known categories, so neighbours in the sorted list differ.
const CATEGORY_TONES = {
    'Databases': 'success',
    'DevOps & Cloud': 'attention',
    'Frameworks': 'active',
    'Programming Languages': 'success',
    'Tools': 'attention',
}

// tone name ('active' | 'attention' | 'success') for a category
export function categoryTone(category = '') {
    if (CATEGORY_TONES[category]) return CATEGORY_TONES[category]
    let hash = 0
    for (let i = 0; i < category.length; i++) hash = category.charCodeAt(i) + ((hash << 5) - hash)
    return TONES[Math.abs(hash) % TONES.length]
}

const TONE_VAR = { active: 'var(--sys-active)', attention: 'var(--sys-attention)', success: 'var(--sys-success)' }

// CSS colour (a token) for a category, for callers that need a raw colour.
export function categoryColor(category = '') {
    return TONE_VAR[categoryTone(category)]
}

// Tone for a subcategory, given the (category, subcategory) pairs.
export function toneForSubcategory(pairs = [], subcategory = null) {
    if (!subcategory) return 'active'
    const pair = pairs.find(p => p.subcategory === subcategory)
    return categoryTone(pair ? pair.category : '')
}

// Colour (token) for a subcategory. Kept for compatibility.
export function accentForSubcategory(pairs = [], subcategory = null) {
    return TONE_VAR[toneForSubcategory(pairs, subcategory)]
}

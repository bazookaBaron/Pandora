// Shared helpers for rendering job postings (JobsPage + JobsCompanyPage).
// Every field added by the jobs feed API (postedAt, repostedAt, isReposted,
// applyUrl, altUrls, source) is optional - all helpers degrade gracefully.

export function relTime(iso) {
    if (!iso) return ''
    const t = new Date(iso).getTime()
    if (Number.isNaN(t)) return ''
    const s = Math.max(0, (Date.now() - t) / 1000)
    if (s < 90) return 'just now'
    if (s < 3600) return Math.round(s / 60) + 'm ago'
    if (s < 86400) return Math.round(s / 3600) + 'h ago'
    return Math.round(s / 86400) + 'd ago'
}

// Only http(s) URLs may become an href (blocks javascript:/data: etc.).
export function safeHttpUrl(u) {
    if (typeof u !== 'string' || !u) return null
    try {
        const parsed = new URL(u)
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
    } catch {
        return null
    }
}

const SOURCE_LABELS = {
    linkedin: 'LinkedIn', greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby',
    workday: 'Workday', smartrecruiters: 'SmartRecruiters', workable: 'Workable',
    recruitee: 'Recruitee', icims: 'iCIMS', bamboohr: 'BambooHR', oracle: 'Oracle',
    custom: 'Careers site',
}
export function sourceLabel(source) {
    if (!source || typeof source !== 'string') return ''
    const key = source.toLowerCase()
    if (SOURCE_LABELS[key]) return SOURCE_LABELS[key]
    return source.charAt(0).toUpperCase() + source.slice(1)
}

// The best timestamp we have for "when was this posted": postedAt, falling
// back to firstSeen for API versions / rows that don't carry it.
export function postedTime(j) {
    return j?.postedAt || j?.firstSeen || null
}

export function isFreshJob(j) {
    const iso = j?.postedAt
    if (!iso) return false // NEW only when we actually know postedAt
    const t = new Date(iso).getTime()
    return !Number.isNaN(t) && Date.now() - t < 24 * 3600 * 1000
}

// Primary apply link + optional secondary "also on <source>" links.
export function jobLinks(j) {
    const primary = safeHttpUrl(j?.applyUrl) || safeHttpUrl(j?.url)
    const seen = new Set(primary ? [primary] : [])
    const alts = []
    for (const a of Array.isArray(j?.altUrls) ? j.altUrls : []) {
        const href = safeHttpUrl(a?.url)
        if (!href || seen.has(href)) continue
        seen.add(href)
        alts.push({ href, label: sourceLabel(a?.source) || 'another site' })
    }
    return { primary, alts }
}

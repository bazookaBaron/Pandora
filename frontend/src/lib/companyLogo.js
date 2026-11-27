import { COMPANY_DOMAIN_MAP } from './companyDomains.js'

// Logo resolution order for a company:
//   1. companyLogo   (crawler.company logo_url || icon_url, from the jobs API)
//   2. Google favicon of companyDomain (crawler.company.domain)
//   3. Google favicon of the static COMPANY_DOMAIN_MAP entry (by name, then slug,
//      case-insensitive)
// then the caller falls back to a letter tile. Each source is tried in turn;
// an <img onError> advances to the next one.

const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

let byLower = null
let bySlug = null
function buildIndexes() {
    byLower = new Map()
    bySlug = new Map()
    for (const [name, domain] of Object.entries(COMPANY_DOMAIN_MAP)) {
        const lower = name.trim().toLowerCase()
        if (!byLower.has(lower)) byLower.set(lower, domain)
        const slug = slugify(name)
        if (slug && !bySlug.has(slug)) bySlug.set(slug, domain)
    }
}

export function lookupMappedDomain(name, slug) {
    if (!byLower) buildIndexes()
    const n = String(name || '').trim().toLowerCase()
    if (n && byLower.has(n)) return byLower.get(n)
    const s = slugify(slug) || slugify(name)
    return (s && bySlug.get(s)) || null
}

export const faviconUrl = (domain, size = 64) =>
    `https://www.google.com/s2/favicons?sz=${size}&domain_url=${encodeURIComponent(domain)}`

const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u.trim())
const cleanDomain = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')

/** Ordered, de-duplicated list of image URLs to try. Empty => letter tile. */
export function logoSources({ logo, domain, name, slug, size = 64 } = {}) {
    const out = []
    if (isHttp(logo)) out.push(logo.trim())
    const d = cleanDomain(domain)
    if (d && d.includes('.')) out.push(faviconUrl(d, size))
    const mapped = lookupMappedDomain(name, slug)
    if (mapped) out.push(faviconUrl(mapped, size))
    return [...new Set(out)]
}

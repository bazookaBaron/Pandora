// ── Public-facing numbers and scope wording, in one place ─────────────
// Consumed by BOTH the browser (page copy) and the server (SEO titles,
// descriptions). Keep it a plain data module, like tiers.js.

// Companies whose career pages the crawler tracks (crawler.company has ~527
// rows). Rounded down so the copy stays true as the list grows or shrinks a
// little — update when it crosses the next round number.
export const TRACKED_COMPANIES = '500+'

// What the jobs board (and every "live jobs" number derived from it) covers:
// open postings, posted in the last 24 hours, in these countries. Mirrors
// server.js's JOBS_MAX_AGE_DAYS default and COUNTRIES.
export const JOBS_SCOPE_LABEL = 'US & India, posted in the last 24 hours'

// "2,279" -> "2,200+": a headline count that stays true while the live
// number moves through the day.
export function roundedCountLabel(n) {
    const v = Number(n)
    if (!Number.isFinite(v) || v <= 0) return ''
    if (v < 100) return String(v)
    const step = v >= 10000 ? 1000 : 100
    return `${(Math.floor(v / step) * step).toLocaleString('en-US')}+`
}

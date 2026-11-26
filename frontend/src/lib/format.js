// Shared display formatters. Pure functions, no React. Every one tolerates
// null / undefined / garbage input and returns a safe string instead of throwing.
//
//   rupees(129900)            -> '₹1,299'        (input in PAISE)
//   num(12345)                -> '12,345'        (en-IN grouping)
//   fmtDate(iso)              -> '25 Nov, 02:30 pm'
//   fmtDate(iso, false)       -> '25 Nov 2026'
//   fmtDate(null)             -> '—'             (fallback is the 3rd arg)
//   fmtShortDate(iso)         -> 'Nov 25, 2026'  (en-US, '' when empty; the Referrals format)
//   fmtAgo(iso)               -> 'just now' | '5 min ago' | '3 h ago' | '2 d ago'   (past only)
//   relTime(iso)              -> 'just now' | '5m ago' | 'in 3h' | '2d ago'          (past or future)
//   resetText(iso)            -> 'soon' | 'tomorrow' | 'in 12 days' | 'on Sep 1'     (usage-limit resets)

/** Paise -> '₹1,299' (rounded to whole rupees, Indian digit grouping). */
export const rupees = (paise) => `₹${Math.round((Number(paise) || 0) / 100).toLocaleString('en-IN')}`

/** Number -> '1,23,456' (Indian digit grouping). Non-numbers become 0. */
export const num = (n) => (Number(n) || 0).toLocaleString('en-IN')

function toDate(iso) {
    if (!iso) return null
    const d = iso instanceof Date ? iso : new Date(iso)
    return Number.isNaN(d.getTime()) ? null : d
}

/** en-IN date. withTime: '25 Nov, 02:30 pm'; without: '25 Nov 2026'. */
export function fmtDate(iso, withTime = true, fallback = '—') {
    const d = toDate(iso)
    if (!d) return fallback
    return d.toLocaleString('en-IN', withTime
        ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
        : { day: 'numeric', month: 'short', year: 'numeric' })
}

/** en-US 'Nov 25, 2026' ('' when empty). */
export function fmtShortDate(iso) {
    const d = toDate(iso)
    if (!d) return ''
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Long-form "time since": 'just now', '5 min ago', '3 h ago', '2 d ago'. */
export function fmtAgo(iso) {
    const d = toDate(iso)
    if (!d) return ''
    const s = Math.round((Date.now() - d.getTime()) / 1000)
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.floor(s / 60)} min ago`
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`
    return `${Math.floor(s / 86400)} d ago`
}

/** Compact relative time in either direction: '5m ago', 'in 3h', '2d ago', 'just now'. */
export function relTime(iso) {
    const d = toDate(iso)
    if (!d) return ''
    const diff = d.getTime() - Date.now()
    const past = diff < 0
    const s = Math.abs(diff) / 1000
    let core
    if (s < 60) return 'just now'
    if (s < 3600) core = Math.round(s / 60) + 'm'
    else if (s < 86400) core = Math.round(s / 3600) + 'h'
    else core = Math.round(s / 86400) + 'd'
    return past ? core + ' ago' : 'in ' + core
}

/** When a monthly allowance resets: 'soon', 'tomorrow', 'in 12 days', 'on Sep 1'. Use as `Resets ${resetText(iso)}`. */
export function resetText(iso) {
    const d = toDate(iso)
    if (!d) return ''
    const then = d.getTime()
    const days = Math.round((then - Date.now()) / 86400000)
    if (days <= 0) return 'soon'
    if (days === 1) return 'tomorrow'
    if (days < 30) return `in ${days} days`
    return `on ${new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

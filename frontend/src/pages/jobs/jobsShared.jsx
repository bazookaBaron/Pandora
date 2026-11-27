import { useState } from 'react'
import { logoSources } from '../../lib/companyLogo'
import { relTime, postedTime } from '../../lib/jobUtils'

// Shared bits for the Jobs section (JobsPage, JobsCompanyPage, JobSheet).
export const SEN_LABEL = {
    intern: 'Intern', junior: 'Junior (0–2y)', mid: 'Mid (2–4y)',
    senior: 'Senior (4–8y)', staff: 'Staff (8y+)', principal: 'Principal', unknown: 'Unspecified',
}
export const COMPANY_TYPE_LABEL = { product: 'Product', startup: 'Startup', service: 'Service' }
export const WORK_TYPE_LABEL = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'Onsite' }

export const levelLabel = (j) => (j?.seniority && j.seniority !== 'unknown' ? SEN_LABEL[j.seniority] || j.seniority : '')

// "2h ago" -> "2h", "just now" -> "now": short enough for the row chip.
export function shortAge(j) {
    const r = relTime(postedTime(j))
    if (!r) return ''
    if (r === 'just now') return 'now'
    return r.replace(/ ago$/, '')
}

// 32px logo tile: the company logo (crawler logo -> favicon of its domain -> static
// domain map), else its initial. A failing image falls through to the next source.
// The initial is drawn from a data attribute (CSS ::before) so it never becomes
// part of a heading's text.
export function JobLogo({ name, size = 'md', logo, domain, slug }) {
    const sources = logoSources({ logo, domain, name, slug, size: 64 })
    const key = sources.join('|')
    const [fail, setFail] = useState({ key, n: 0 })
    const idx = fail.key === key ? fail.n : 0
    const initial = (name || '?').trim().charAt(0).toUpperCase() || '?'
    const cls = `jobs-logo${size === 'lg' ? ' is-lg' : ''}`
    if (idx < sources.length) {
        return (
            <span className={cls} aria-hidden="true">
                <img src={sources[idx]} alt="" width={20} height={20}
                    loading="lazy" decoding="async" onError={() => setFail({ key, n: idx + 1 })} />
            </span>
        )
    }
    return <span className={cls} data-initial={initial} aria-hidden="true" />
}

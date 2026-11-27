import { useState } from 'react'
import { COMPANY_DOMAIN_MAP } from '../../lib/companyDomains'
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

// 32px logo tile: the company favicon when we know its domain, else its initial.
// The initial is drawn from a data attribute (CSS ::before) so it never becomes
// part of a heading's text.
export function JobLogo({ name, size = 'md' }) {
    const domain = name ? COMPANY_DOMAIN_MAP[name] : null
    const [failed, setFailed] = useState(false)
    const initial = (name || '?').trim().charAt(0).toUpperCase() || '?'
    const cls = `jobs-logo${size === 'lg' ? ' is-lg' : ''}`
    if (domain && !failed) {
        return (
            <span className={cls} aria-hidden="true">
                <img src={`https://www.google.com/s2/favicons?sz=64&domain_url=${domain}`} alt="" width={20} height={20}
                    loading="lazy" decoding="async" onError={() => setFailed(true)} />
            </span>
        )
    }
    return <span className={cls} data-initial={initial} aria-hidden="true" />
}

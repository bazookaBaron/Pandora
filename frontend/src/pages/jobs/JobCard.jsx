import { ExternalLink } from 'lucide-react'
import { relTime, postedTime, isFreshJob, jobLinks, sourceLabel } from '../../lib/jobUtils'
import SubscribeBell from './SubscribeBell'

// Work type -> semantic tone (left border + the work-type word).
export const LOC_TONE = { remote: 'success', hybrid: 'active', onsite: 'history' }
export const SEN_LABEL = {
    intern: 'Intern', junior: 'Junior (0–2y)', mid: 'Mid (2–4y)',
    senior: 'Senior (4–8y)', staff: 'Staff (8y+)', principal: 'Principal', unknown: 'Unspecified',
}
const COMPANY_TYPE_LABEL = { product: 'Product', startup: 'Startup', service: 'Service', unknown: 'Unspecified' }

// ── one job row ────────────────────────────────────────────────────
// Compact row: title + a NEW / REPOSTED tag, one faint meta line underneath
// (company · location · work-type · level · age), bell + Apply pinned right.
// Phones (≤480px): one line — title + company, icon-only bell and Apply.
//   showCompany=false / showBell=false: the company hub page (the company is the page).
//   rel: link rel for the outbound links (the hub page adds nofollow).
export default function JobCard({ j, showCompany = true, showBell = true, rel = 'noopener noreferrer' }) {
    const fresh = isFreshJob(j)
    const { primary, alts } = jobLinks(j)
    const srcLabel = sourceLabel(j.source)
    const tone = LOC_TONE[j.locationType] || 'history'
    const sen = j.seniority && j.seniority !== 'unknown' ? j.seniority : ''

    const meta = []
    if (showCompany && j.company) meta.push(<span className="job-co">{j.company}</span>)
    if (j.location) meta.push(j.location)
    if (j.locationType) meta.push(<span className="tone-text">{j.locationType}</span>)
    if (j.companyType && j.companyType !== 'unknown') meta.push(COMPANY_TYPE_LABEL[j.companyType] || j.companyType)
    if (sen) meta.push(SEN_LABEL[sen] || sen)
    const when = relTime(postedTime(j))
    if (when) meta.push(when)
    if (srcLabel) meta.push(srcLabel)

    // On phones the one secondary item is the company (or, on the hub page, the age).
    const inline = showCompany ? j.company : when

    return (
        <div className={`job-card tone-${tone}`}>
            <div className="job-main">
                <div className="job-line">
                    <a href={primary || undefined} target="_blank" rel={rel} className="job-title" title={j.title || undefined}>
                        {j.title || 'Untitled role'}
                    </a>
                    {fresh && <span className="job-tag is-new tone-waiting" title="Posted recently">NEW</span>}
                    {j.isReposted && <span className="job-tag is-reposted tone-plan">REPOSTED</span>}
                    {inline && <span className="job-co-inline">{inline}</span>}
                </div>
                <div className="job-meta">
                    {meta.map((m, i) => (
                        <span key={i}>
                            {i > 0 && <span className="job-sep" aria-hidden="true">{' · '}</span>}
                            {m}
                        </span>
                    ))}
                </div>
            </div>

            {showBell && <SubscribeBell slug={j.companySlug} companyName={j.company} />}

            <div className="job-actions">
                {primary && (
                    <a href={primary} target="_blank" rel={rel} className="sys-btn job-apply"
                        aria-label={`Apply: ${j.title || 'role'}${j.company ? ` at ${j.company}` : ''} (opens in a new tab)`}>
                        <span className="job-apply-word">Apply</span>
                        <ExternalLink size={12} aria-hidden="true" />
                    </a>
                )}
                {alts.slice(0, 1).map((a) => (
                    <a key={a.href} href={a.href} target="_blank" rel={rel} className="job-alt">
                        also on {a.label}
                    </a>
                ))}
            </div>
        </div>
    )
}

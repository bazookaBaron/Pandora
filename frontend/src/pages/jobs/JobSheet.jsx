import { Link } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import { Sheet } from '../../components/ui'
import { getSection } from '../../lib/sections'
import { CTA } from '../../lib/copy'
import { track, TRACK } from '../../lib/track'
import { relTime, postedTime, jobLinks, sourceLabel } from '../../lib/jobUtils'
import SubscribeBell from './SubscribeBell'
import { COMPANY_TYPE_LABEL, WORK_TYPE_LABEL, levelLabel } from './jobsShared'

const TONE = getSection('jobs')

function postedText(j) {
    const iso = postedTime(j)
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const date = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
    return `${relTime(iso)} · ${date}`
}

// Job details in a bottom sheet (dialog on desktop): role, location, posted
// time, one outbound Apply button and the company alert bell.
//   rel: rel of the outbound links (the company page adds nofollow)
//   showBell: false on the company page (its header has Subscribe)
//   linkCompany: link the company name to its jobs page
export default function JobSheet({ job, onClose, rel = 'noopener noreferrer', showBell = true, linkCompany = true }) {
    if (!job) return null
    const j = job
    const { primary, alts } = jobLinks(j)
    const facts = [
        j.location && ['Location', j.location],
        WORK_TYPE_LABEL[j.locationType] && ['Work type', WORK_TYPE_LABEL[j.locationType]],
        levelLabel(j) && ['Level', levelLabel(j)],
        COMPANY_TYPE_LABEL[j.companyType] && ['Company type', COMPANY_TYPE_LABEL[j.companyType]],
        postedText(j) && ['Posted', postedText(j) + (j.isReposted ? ' (reposted)' : '')],
        sourceLabel(j.source) && ['Source', sourceLabel(j.source)],
    ].filter(Boolean)

    const footer = (
        <div className="jobs-sheet-foot" style={{ '--tone': TONE.tone, '--tone-dim': TONE.toneDim }}>
            {primary ? (
                <a href={primary} target="_blank" rel={rel} className="sys-tone-btn"
                    aria-label={`${CTA.apply}${j.company ? ` at ${j.company}` : ''} (opens in a new tab)`}
                    onClick={() => track(TRACK.CTA_CLICK, { id: 'job_apply', section: 'jobs' })}>
                    <span>{CTA.apply}</span>
                    <ExternalLink size={16} aria-hidden="true" />
                </a>
            ) : (
                <span className="jobs-sheet-nolink">No apply link for this job.</span>
            )}
            {showBell && <SubscribeBell slug={j.companySlug} companyName={j.company} />}
        </div>
    )

    return (
        <Sheet open onClose={onClose} title={j.title || 'Untitled role'} description={j.company || undefined} footer={footer}>
            <dl className="jobs-facts">
                {facts.map(([k, v]) => (
                    <div key={k} className="jobs-fact">
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                    </div>
                ))}
            </dl>
            {linkCompany && j.companySlug && j.company && (
                <p className="jobs-alts">
                    <Link to={`/jobs/company/${encodeURIComponent(j.companySlug)}`} onClick={onClose}>All {j.company} jobs</Link>
                </p>
            )}
            {alts.length > 0 && (
                <p className="jobs-alts">
                    Also on{' '}
                    {alts.slice(0, 3).map((a, i) => (
                        <span key={a.href}>
                            {i > 0 && ', '}
                            <a href={a.href} target="_blank" rel={rel}>{a.label}</a>
                        </span>
                    ))}
                </p>
            )}
        </Sheet>
    )
}

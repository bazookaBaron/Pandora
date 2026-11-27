import { Row } from '../../components/ui'
import { isFreshJob } from '../../lib/jobUtils'
import { JobLogo, WORK_TYPE_LABEL, levelLabel, shortAge } from './jobsShared'

// One job = one line on phones: logo · title · company · age chip.
// From 768px a second line adds location · work type · level.
// Tapping the row opens the job sheet (details + Apply).
//   showCompany=false: the company page (the company is the page itself), so
//   no logo and no company name; phones show title + age only.
export default function JobRow({ j, showCompany = true, onOpen }) {
    const age = shortAge(j)
    const title = j.title || 'Untitled role'
    const inline = showCompany ? j.company : ''
    const sub = [showCompany && j.company, j.location, WORK_TYPE_LABEL[j.locationType], levelLabel(j)]
        .filter(Boolean).join(' · ')
    return (
        <Row
            className="jobs-row"
            leading={showCompany ? <JobLogo name={j.company} /> : undefined}
            title={(
                <span className="jobs-row-t">
                    <span className="jobs-row-role" title={title}>{title}</span>
                    {inline && <span className="jobs-row-co">{inline}</span>}
                </span>
            )}
            sub={sub || undefined}
            meta={age || undefined}
            metaTone={isFreshJob(j) ? 'success' : undefined}
            onClick={() => onOpen(j)}
        />
    )
}

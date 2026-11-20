import { Link } from 'react-router-dom'

export const MEETING_LABEL = {
    zoom: 'Zoom', google_meet: 'Google Meet', teams: 'Microsoft Teams', webex: 'Webex', chime: 'Amazon Chime', skype: 'Skype', hirevue: 'HireVue',
}
export const TYPE_LABEL = {
    technical: 'Technical', coding: 'Coding', system_design: 'System design', hiring_manager: 'Hiring manager',
    behavioral: 'Behavioural', hr: 'HR', recruiter_screen: 'Recruiter screen', panel: 'Panel',
}
const MODE_LABEL = { video: 'Video call', phone: 'Phone call', onsite: 'In person' }

export function safeHref(url) {
    try {
        const u = new URL(url)
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
    } catch {
        return null
    }
}

/** "Tue, 24 Nov 2026, 10:30 am" in the viewer's own time zone. */
export function fmtWhen(iso) {
    if (!iso) return null
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return null
    return d.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function localZoneName() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    } catch {
        return ''
    }
}

/** One interview: when, how to join, what kind, link back to the mail. */
export default function InterviewCard({ iv, showMailLink = true, past = false }) {
    const join = safeHref(iv.meeting_url)
    const schedule = safeHref(iv.schedule_url)
    const when = fmtWhen(iv.starts_at)
    const facts = [iv.round, TYPE_LABEL[iv.interview_type], MODE_LABEL[iv.mode], iv.duration_min ? `${iv.duration_min} min` : null].filter(Boolean)
    return (
        <article className={`aa-card aa-stack aa-iv${past ? ' is-past' : ' is-pop'}`} style={{ gap: 8 }} aria-label={`Interview${iv.company ? ` with ${iv.company}` : ''}`}>
            <div className="aa-spread" style={{ gap: 10, alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                    <span className="aa-mail-subject">{iv.company || 'Interview'}{iv.role ? ` · ${iv.role}` : ''}</span>
                    <span className="aa-muted" style={{ display: 'block' }}>
                        {when ? (
                            <>
                                <time dateTime={iv.starts_at}>{when}</time>
                                <span className="aa-faint"> ({localZoneName() || 'your time'})</span>
                            </>
                        ) : (
                            <span>Time not set yet{schedule ? ': pick a slot with the link below' : ''}</span>
                        )}
                    </span>
                    {when && (iv.timezone || iv.time_text) && (
                        <span className="aa-faint" style={{ display: 'block', overflowWrap: 'anywhere' }}>
                            As written: {iv.time_text || iv.timezone}
                        </span>
                    )}
                    {when && iv.tz_assumed && (
                        <span className="aa-faint" style={{ display: 'block' }}>The mail did not name a time zone; we read it as India time. Check the mail.</span>
                    )}
                </div>
                {past && <span className="aa-pill t-muted">Past</span>}
            </div>
            {facts.length > 0 && (
                <div className="aa-row" style={{ gap: 6 }}>
                    {facts.map((f) => <span key={f} className="aa-pill">{f}</span>)}
                </div>
            )}
            {iv.location && <span className="aa-muted" style={{ overflowWrap: 'anywhere' }}><strong>Where:</strong> {iv.location}</span>}
            <div className="aa-row">
                {join && (
                    <a className="aa-btn is-primary" href={join} target="_blank" rel="noopener noreferrer nofollow" title={join}>
                        Join on {MEETING_LABEL[iv.meeting_provider] || 'the meeting link'} ↗
                    </a>
                )}
                {schedule && (
                    <a className="aa-btn" href={schedule} target="_blank" rel="noopener noreferrer nofollow" title={schedule}>Pick a time ↗</a>
                )}
                {showMailLink && iv.mail_event_id && (
                    <Link className="aa-btn" to={`/autoapply/inbox?mail=${encodeURIComponent(iv.mail_event_id)}`}>Open the mail</Link>
                )}
            </div>
        </article>
    )
}

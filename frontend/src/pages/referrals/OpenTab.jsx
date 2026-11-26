import { useState } from 'react'
import { Briefcase, Building2, Clock, Hash } from 'lucide-react'
import { ApiError } from '../../lib/apiClient'
import { EmptyState, ErrorState, LoadingState, errorText } from '../../components/shared/states'
import { Button } from '../../components/ui'
import { relTime } from '../../lib/format'
import { fetchResumeUrl, useAcceptReferral, useOpenReferrals } from '../../lib/useReferrals'
import { Chip } from './Chips'
import VerifyHint from './VerifyHint'

// ── Tab: Open for my company ──────────────────────────────────────
function OpenCard({ r }) {
    const accept = useAcceptReferral()
    const [viewing, setViewing] = useState(false)
    const [viewErr, setViewErr] = useState('')
    const [accepted, setAccepted] = useState(false)
    const [gone, setGone] = useState(false)
    const [acceptErr, setAcceptErr] = useState('')

    const viewResume = async () => {
        setViewing(true)
        setViewErr('')
        try {
            await fetchResumeUrl(r.id)
        } catch (err) {
            if (err instanceof ApiError && err.status === 403) setViewErr('The resume is available only to the person who accepted this request.')
            else setViewErr(errorText(err))
        } finally {
            setViewing(false)
        }
    }

    const doAccept = async () => {
        setAcceptErr('')
        try {
            await accept.mutateAsync(r.id)
            setAccepted(true)
        } catch (err) {
            if (err instanceof ApiError && err.code === 'already_accepted') {
                setAcceptErr('This request was just accepted by someone else.')
                setGone(true)
            } else if (err instanceof ApiError && err.code === 'accept_limit') {
                setAcceptErr(err.body?.message || "You've reached today's accept limit. Try again later.")
            } else if (err instanceof ApiError && err.code === 'no_company') {
                setAcceptErr('Add your current company in your profile before accepting.')
            } else {
                setAcceptErr(errorText(err))
            }
        }
    }

    if (accepted) {
        return (
            <div className="ref-card tone-success">
                <span className="sys-note is-ok" role="status">
                    Accepted — the candidate has been emailed your contact info.
                </span>
                <div>
                    <Button onClick={viewResume} busy={viewing} busyLabel="Opening…">View resume</Button>
                </div>
                {viewErr && <span className="ref-err" role="alert">{viewErr}</span>}
            </div>
        )
    }

    const cand = r.poster || {}
    const title = r.job_title || 'Referral request'

    return (
        <div className={`ref-card tone-${gone ? 'history' : 'active'}`}>
            <div className="ref-head">
                <span className="ref-title" title={title}>{title}</span>
                <span className="sys-chips">
                    <Chip icon={Building2} title="Target company">{r.target_company}</Chip>
                    {r.job_id && <Chip icon={Hash} title="Job ID">{r.job_id}</Chip>}
                    {cand.position && <Chip icon={Briefcase} title="Candidate's current role">{cand.position}</Chip>}
                    {cand.years_of_experience != null && cand.years_of_experience !== '' && (
                        <Chip icon={Clock} title="Years of experience">{cand.years_of_experience} yrs</Chip>
                    )}
                </span>
                {!gone && (
                    <span className="ref-head-end">
                        <Button variant="primary" onClick={doAccept} busy={accept.isPending} busyLabel="Accepting…">
                            Accept &amp; refer
                        </Button>
                    </span>
                )}
            </div>
            <span className="ref-time">
                Posted {relTime(r.created_at)} · expires {relTime(r.expires_at)}
            </span>

            {acceptErr && <span className="ref-err" role="alert">{acceptErr}</span>}
        </div>
    )
}

export default function OpenTab() {
    const { data, isLoading, error, refetch } = useOpenReferrals()

    if (isLoading) return <LoadingState />
    if (error) return <ErrorState err={error} onRetry={refetch} />

    if (data?.no_company) {
        return (
            <EmptyState
                art="people"
                tone="active"
                title="Add your company to see referral requests"
                message="Set your current company in your profile to see requests targeting it."
                action={<Button to="/profile">Edit profile</Button>}
            />
        )
    }

    const requests = data?.requests || []
    const hint = data?.viewerVerified === false ? <VerifyHint company={data?.company} /> : null
    if (requests.length === 0) {
        const company = data?.company
        return (
            <>
                {hint}
                <EmptyState
                    art="inbox"
                    title={`No open referral requests${company ? ` for ${company}` : ''} right now`}
                />
            </>
        )
    }

    return (
        <>
            {hint}
            <div className="ref-list">
                {requests.map((r) => <OpenCard key={r.id} r={r} />)}
            </div>
        </>
    )
}

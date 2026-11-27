import { useState } from 'react'
import { Building2 } from 'lucide-react'
import { ApiError } from '../../lib/apiClient'
import { EmptyState, ErrorState, LoadingState, errorText } from '../../components/shared/states'
import { Button, Row, Sheet } from '../../components/ui'
import { relTime } from '../../lib/format'
import { fetchResumeUrl, useAcceptReferral, useOpenReferrals } from '../../lib/useReferrals'
import { Fact } from './Chips'
import VerifyHint from './VerifyHint'
import { getSection } from '../../lib/sections'

const TONE = getSection('referrals').tone

// ── Tab: Give (open requests for my company) ───────────────────────
// One row per request; the details and the Accept button live in a sheet.

function OpenSheet({ r, onClose, accepted, onAccepted }) {
    const accept = useAcceptReferral()
    const [viewing, setViewing] = useState(false)
    const [viewErr, setViewErr] = useState('')
    const [gone, setGone] = useState(false)
    const [acceptErr, setAcceptErr] = useState('')

    const viewResume = async () => {
        setViewing(true)
        setViewErr('')
        try {
            await fetchResumeUrl(r.id)
        } catch (err) {
            if (err instanceof ApiError && err.status === 403) setViewErr('Only the person who accepted can see the resume.')
            else setViewErr(errorText(err))
        } finally {
            setViewing(false)
        }
    }

    const doAccept = async () => {
        setAcceptErr('')
        try {
            await accept.mutateAsync(r.id)
            onAccepted(r.id)
        } catch (err) {
            if (err instanceof ApiError && err.code === 'already_accepted') {
                setAcceptErr('Someone else just accepted this request.')
                setGone(true)
            } else if (err instanceof ApiError && err.code === 'accept_limit') {
                setAcceptErr(err.body?.message || "You've reached today's accept limit. Try again later.")
            } else if (err instanceof ApiError && err.code === 'no_company') {
                setAcceptErr('Add your current company in your profile first.')
            } else {
                setAcceptErr(errorText(err))
            }
        }
    }

    const cand = r.poster || {}
    const yoe = cand.years_of_experience != null && cand.years_of_experience !== '' ? `${cand.years_of_experience} yrs` : null

    const footer = accepted ? (
        <Button variant="primary" size="lg" block onClick={viewResume} busy={viewing} busyLabel="Opening…">View resume</Button>
    ) : gone ? null : (
        <button type="button" className="sys-tone-btn is-block" style={{ '--tone': TONE }} onClick={doAccept} disabled={accept.isPending} aria-busy={accept.isPending || undefined}>
            {accept.isPending && <span className="sys-spin" aria-hidden="true" />}
            <span>{accept.isPending ? 'Accepting…' : 'Accept and refer'}</span>
        </button>
    )

    return (
        <Sheet open onClose={onClose} title={r.job_title || 'Referral request'} description={r.target_company} footer={footer}>
            <div className="rf-sheet">
                {accepted && (
                    <p className="sys-note is-ok" role="status">Accepted. The candidate got your contact info by email.</p>
                )}
                <div className="rf-facts">
                    <Fact label="Company">{r.target_company}</Fact>
                    <Fact label="Job ID">{r.job_id}</Fact>
                    <Fact label="Their role">{cand.position}</Fact>
                    <Fact label="Experience">{yoe}</Fact>
                    <Fact label="Posted">{relTime(r.created_at)}</Fact>
                    <Fact label="Expires">{relTime(r.expires_at)}</Fact>
                </div>
                {acceptErr && <p className="ref-err" role="alert">{acceptErr}</p>}
                {viewErr && <p className="ref-err" role="alert">{viewErr}</p>}
            </div>
        </Sheet>
    )
}

export default function OpenTab() {
    const { data, isLoading, error, refetch } = useOpenReferrals()
    const [openId, setOpenId] = useState(null)
    const [snapshot, setSnapshot] = useState(null) // keeps the sheet open if the list refetches
    const [acceptedIds, setAcceptedIds] = useState(() => new Set())

    if (isLoading) return <LoadingState />
    if (error) return <ErrorState err={error} onRetry={refetch} />

    if (data?.no_company) {
        return (
            <EmptyState
                art="people"
                tone="active"
                title="Add your company to see requests"
                action={<Button to="/profile">Edit profile</Button>}
            />
        )
    }

    const requests = data?.requests || []
    const hint = data?.viewerVerified === false ? <VerifyHint company={data?.company} /> : null
    const current = openId ? (requests.find((r) => r.id === openId) || snapshot) : null
    const markAccepted = (id) => setAcceptedIds((s) => new Set(s).add(id))

    return (
        <>
            {hint}
            {requests.length === 0 ? (
                <EmptyState art="inbox" title={`No open requests${data?.company ? ` for ${data.company}` : ''} yet`} />
            ) : (
                <ul className="sys-rows" aria-label="Open referral requests">
                    {requests.map((r) => {
                        const done = acceptedIds.has(r.id)
                        return (
                            <li key={r.id}>
                                <Row
                                    leading={<Building2 size={18} aria-hidden="true" />}
                                    title={r.job_title || 'Referral request'}
                                    sub={[r.target_company, r.poster?.position].filter(Boolean).join(' · ')}
                                    meta={done ? 'Accepted' : relTime(r.created_at)}
                                    metaTone={done ? 'success' : undefined}
                                    onClick={() => { setOpenId(r.id); setSnapshot(r) }}
                                />
                            </li>
                        )
                    })}
                </ul>
            )}
            {current && (
                <OpenSheet
                    key={current.id}
                    r={current}
                    accepted={acceptedIds.has(current.id)}
                    onAccepted={markAccepted}
                    onClose={() => { setOpenId(null); setSnapshot(null) }}
                />
            )}
        </>
    )
}

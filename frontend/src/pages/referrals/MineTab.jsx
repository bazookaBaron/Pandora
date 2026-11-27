import { useState } from 'react'
import { ApiError } from '../../lib/apiClient'
import { EmptyState, ErrorState, LoadingState, errorText } from '../../components/shared/states'
import { Button, InlineConfirm, Row, Sheet } from '../../components/ui'
import { relTime } from '../../lib/format'
import { useCancelReferral, useMyReferrals } from '../../lib/useReferrals'
import { CTA } from '../../lib/copy'
import { Fact, VerifiedBadge, statusLabel, statusTone } from './Chips'

// ── Tab: Mine (my requests) ───────────────────────────────────────
// One status row per request; details, contact and Cancel open in a sheet.

function MineSheet({ r, onClose }) {
    const cancel = useCancelReferral()
    const [confirming, setConfirming] = useState(false)
    const [cancelErr, setCancelErr] = useState('')

    const doCancel = async () => {
        setCancelErr('')
        try {
            await cancel.mutateAsync(r.id)
            setConfirming(false)
            onClose()
        } catch (err) {
            setConfirming(false)
            if (err instanceof ApiError && err.code === 'not_open_or_not_owner') {
                setCancelErr('This request can no longer be cancelled.')
            } else {
                setCancelErr(errorText(err))
            }
        }
    }

    const footer = r.status === 'open' ? (
        confirming ? (
            <InlineConfirm
                message="Cancel this request? This month's quota is not refunded."
                confirmLabel="Yes, cancel"
                onConfirm={doCancel}
                onCancel={() => setConfirming(false)}
                busy={cancel.isPending}
            />
        ) : (
            <Button variant="ghost" size="lg" block onClick={() => setConfirming(true)}>Cancel request</Button>
        )
    ) : null

    return (
        <Sheet open onClose={onClose} title={r.target_company} description={r.job_title || undefined} footer={footer}>
            <div className="rf-sheet">
                {r.status === 'accepted' && r.accepter && (
                    <div className="sys-note is-ok rf-contact">
                        <p><strong>{r.accepter.name}</strong> accepted. Email them:</p>
                        <p><a href={`mailto:${r.accepter.email}`}>{r.accepter.email}</a></p>
                        {r.referrerVerified && <VerifiedBadge company={r.target_company} />}
                    </div>
                )}
                <div className="rf-facts">
                    <Fact label="Status">{statusLabel(r.status)}</Fact>
                    <Fact label="Role">{r.job_title}</Fact>
                    <Fact label="Job ID">{r.job_id}</Fact>
                    <Fact label="Posted">{relTime(r.created_at)}</Fact>
                    <Fact label="Expires">{relTime(r.expires_at)}</Fact>
                </div>
                {cancelErr && <p className="ref-err" role="alert">{cancelErr}</p>}
            </div>
        </Sheet>
    )
}

export default function MineTab({ onAsk }) {
    const { data, isLoading, error, refetch } = useMyReferrals()
    const [openId, setOpenId] = useState(null)

    if (isLoading) return <LoadingState />
    if (error) return <ErrorState err={error} onRetry={refetch} />

    const requests = data?.requests || []
    const current = openId ? requests.find((r) => r.id === openId) : null

    if (requests.length === 0) {
        return (
            <EmptyState
                art="referrals"
                title="No requests yet"
                action={onAsk ? <Button variant="primary" onClick={onAsk}>{CTA.askReferral}</Button> : null}
            />
        )
    }

    return (
        <>
            <ul className="sys-rows" aria-label="My referral requests">
                {requests.map((r) => (
                    <li key={r.id}>
                        <Row
                            title={r.target_company}
                            sub={r.job_title || `Posted ${relTime(r.created_at)}`}
                            meta={statusLabel(r.status)}
                            metaTone={statusTone(r.status)}
                            onClick={() => setOpenId(r.id)}
                        />
                    </li>
                ))}
            </ul>
            {current && <MineSheet key={current.id} r={current} onClose={() => setOpenId(null)} />}
        </>
    )
}

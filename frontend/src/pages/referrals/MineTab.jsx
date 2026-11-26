import { useState } from 'react'
import { Briefcase, Hash } from 'lucide-react'
import { ApiError } from '../../lib/apiClient'
import { EmptyState, ErrorState, LoadingState, errorText } from '../../components/shared/states'
import { Button, InlineConfirm, StatusPill } from '../../components/ui'
import { relTime } from '../../lib/format'
import { useCancelReferral, useMyReferrals } from '../../lib/useReferrals'
import { Chip, QuotaLine, REFERRAL_STATUS, VerifiedBadge, statusTone } from './Chips'

// ── Tab: My requests ─────────────────────────────────────────────
function MineCard({ r }) {
    const cancel = useCancelReferral()
    const [confirming, setConfirming] = useState(false)
    const [cancelErr, setCancelErr] = useState('')

    const doCancel = async () => {
        setCancelErr('')
        try {
            await cancel.mutateAsync(r.id)
            setConfirming(false)
        } catch (err) {
            setConfirming(false)
            if (err instanceof ApiError && err.code === 'not_open_or_not_owner') {
                setCancelErr('This request can no longer be cancelled.')
            } else {
                setCancelErr(errorText(err))
            }
        }
    }

    return (
        <div className={`ref-card tone-${statusTone(r.status)}`}>
            <div className="ref-head">
                <span className="ref-title" title={r.target_company}>{r.target_company}</span>
                <span className="sys-chips">
                    {r.job_title && <Chip icon={Briefcase} title="Job title">{r.job_title}</Chip>}
                    {r.job_id && <Chip icon={Hash} title="Job ID">{r.job_id}</Chip>}
                </span>
                <span className="ref-head-end">
                    <StatusPill map={REFERRAL_STATUS} status={r.status} />
                </span>
            </div>
            <span className="ref-time">
                Posted {relTime(r.created_at)} · expires {relTime(r.expires_at)}
            </span>

            {r.status === 'accepted' && r.accepter && (
                <div className="sys-note is-ok ref-contact" style={{ color: 'var(--accent)' }}>
                    <strong>{r.accepter.name}</strong> accepted — reach out:{' '}
                    <a href={`mailto:${r.accepter.email}`}>{r.accepter.email}</a>
                    {r.referrerVerified && (
                        <span style={{ marginLeft: 8 }}><VerifiedBadge company={r.target_company} /></span>
                    )}
                </div>
            )}

            {r.status === 'open' && (
                confirming ? (
                    <InlineConfirm
                        message="Cancel this request? This month's quota isn't refunded."
                        confirmLabel="Yes, cancel"
                        onConfirm={doCancel}
                        onCancel={() => setConfirming(false)}
                        busy={cancel.isPending}
                    />
                ) : (
                    <div>
                        <Button variant="ghost" onClick={() => setConfirming(true)}>Cancel request</Button>
                    </div>
                )
            )}

            {cancelErr && <span className="ref-err" role="alert">{cancelErr}</span>}
        </div>
    )
}

export default function MineTab() {
    const { data, isLoading, error, refetch } = useMyReferrals()

    if (isLoading) return <LoadingState />
    if (error) return <ErrorState err={error} onRetry={refetch} />

    const requests = data?.requests || []

    return (
        <div className="ref-stack">
            <QuotaLine usage={data?.usage} />
            {requests.length === 0 ? (
                <EmptyState art="referrals" title="You haven't posted any referral requests yet" />
            ) : (
                <div className="ref-list">
                    {requests.map((r) => <MineCard key={r.id} r={r} />)}
                </div>
            )}
        </div>
    )
}

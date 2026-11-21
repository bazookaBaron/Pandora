import { useMemo } from 'react'
import { useAnswers, useAutoApplyMe, useBatches, useNeedsYou } from '../../lib/useAutoApply'

// ── AutoApply progress, derived only from server state ──────────────
// Sources (GET /api/autoapply/me unless noted):
//   resume   -> resume_path
//   answers  -> readiness.missing (keys other than onboarding/resume/email); required questions
//               that have a default (GET /answers questions[].default) count as answered, the same
//               way the server's gate counts them once onboarding is done
//   prefs    -> prefs.titles (the Preferences step requires at least one title)
//   email    -> readiness.missing has no 'email' (alias or contact email present)
//   consent  -> consent_at && onboarding_done
//   buy      -> GET /batches (the list already excludes pending_payment)
//   review   -> a batch past 'review' (or review_before_apply === false: nothing to review)
//   track    -> GET /needs-you count; always the final, ongoing step

const NON_ANSWER_KEYS = new Set(['onboarding', 'resume', 'email'])
const PRE_REVIEW = ['paid', 'shortlisting']
const PAST_REVIEW = ['running', 'paused', 'waiting_supply', 'completed', 'expired', 'refund_due', 'refunding', 'refunded']

export const GUIDE_STEPS = [
    { id: 'resume', label: 'Resume' },
    { id: 'answers', label: 'Questions' },
    { id: 'prefs', label: 'Preferences' },
    { id: 'email', label: 'Email' },
    { id: 'consent', label: 'Consent' },
    { id: 'buy', label: 'Buy a pack' },
    { id: 'review', label: 'Review' },
    { id: 'track', label: 'Track' },
]

const missingKey = (m) => (m && typeof m === 'object' ? m.key : String(m || ''))

/**
 * -> { ready, eligible, steps: [{ id, label, state: 'done'|'current'|'locked', title, text, cta: {to, label} }],
 *      current, doneCount, total }
 * `ready` is false until /me (and, for eligible users, /batches) have loaded.
 */
export function useAAGuide() {
    const me = useAutoApplyMe()
    const eligible = !!me.data?.eligible
    const batchesQ = useBatches()
    const needsQ = useNeedsYou()
    const answersQ = useAnswers()

    const ready = !!me.data && (!eligible || !!batchesQ.data || batchesQ.isError)

    return useMemo(() => {
        const d = me.data
        if (!d) return { ready: false, eligible: false, steps: [], current: null, doneCount: 0, total: GUIDE_STEPS.length }

        const readiness = d.readiness || {}
        const missing = (readiness.missing || d.profile_check?.missing || []).map(missingKey)
        const defaulted = new Set(
            (answersQ.data?.questions || []).filter((q) => q && q.required && q.default != null).map((q) => q.key),
        )
        const answerGaps = missing.filter((k) => !NON_ANSWER_KEYS.has(k) && !defaulted.has(k))
        const firstAnswerFix = (readiness.missing || []).find((m) => m && answerGaps.includes(m.key))?.fix

        const batches = batchesQ.data?.batches || []
        const inReview = batches.find((b) => b.status === 'review')
        const building = batches.find((b) => PRE_REVIEW.includes(b.status))
        const waitingProfile = batches.find((b) => b.status === 'waiting_profile')
        const pastReview = batches.some((b) => PAST_REVIEW.includes(b.status))
        const needCount = needsQ.data?.items?.length || 0
        const reviewHours = d.config?.review_hours ?? 6
        const skipReview = d.review_before_apply === false

        const done = {
            resume: !!d.resume_path && !missing.includes('resume'),
            answers: answerGaps.length === 0,
            prefs: Array.isArray(d.prefs?.titles) && d.prefs.titles.length > 0,
            email: !missing.includes('email'),
            consent: !!d.consent_at && !!d.onboarding_done,
            buy: batches.length > 0,
            review: pastReview || (skipReview && batches.length > 0 && !inReview && !building),
            track: false,
        }

        const copy = {
            resume: {
                title: 'Upload your resume',
                text: 'A PDF or DOCX; we read it to prefill your profile and attach it to every application.',
                cta: { to: '/autoapply/account?step=resume', label: 'Upload resume' },
            },
            answers: {
                title: 'Answer the screening questions',
                text: answerGaps.length
                    ? `${answerGaps.length} answer${answerGaps.length === 1 ? '' : 's'} left; career sites ask these on almost every form.`
                    : 'The standard questions career sites ask on almost every form.',
                cta: { to: firstAnswerFix || '/autoapply/account?step=answers', label: 'Answer questions' },
            },
            prefs: {
                title: 'Set your preferences',
                text: 'Pick the job titles and cities you want; you choose how fresh the postings are when you buy.',
                cta: { to: '/autoapply/account?step=prefs', label: 'Set preferences' },
            },
            email: {
                title: 'Connect your apply email',
                text: 'Choose where recruiter replies and verification codes go.',
                cta: { to: '/autoapply/account?step=email', label: 'Set up email' },
            },
            consent: {
                title: 'Give consent',
                text: 'Confirm we may apply on your behalf and whether you want to review the shortlist first.',
                cta: { to: '/autoapply/account?step=consent', label: 'Confirm' },
            },
            buy: {
                title: 'Buy a pack',
                text: 'Pick service or product companies and a size; credits are used only when an application is submitted.',
                cta: { to: '/autoapply/buy', label: 'Buy a pack' },
            },
            review: inReview ? {
                title: 'Review your shortlist',
                text: `Remove jobs you don't want or approve early; we start applying after the ${reviewHours}-hour window.`,
                cta: { to: `/autoapply/batches/${inReview.id}`, label: 'Review shortlist' },
            } : waitingProfile ? {
                title: 'Your batch is waiting for your profile',
                text: 'Finish the missing profile items and we build your shortlist right away.',
                cta: { to: `/autoapply/batches/${waitingProfile.id}`, label: 'Open batch' },
            } : {
                title: 'We are building your shortlist',
                text: skipReview
                    ? 'You chose to skip the review, so we start applying as soon as the shortlist is ready.'
                    : `We'll let you review it for ${reviewHours} hours before applying.`,
                cta: { to: building ? `/autoapply/batches/${building.id}` : '/autoapply', label: 'Open batch' },
            },
            track: needCount > 0 ? {
                title: 'Some applications need you',
                text: `${needCount} site${needCount === 1 ? '' : 's'} need a captcha, a sign-in or an answer from you.`,
                cta: { to: '/autoapply/needs-you', label: `Open Needs you (${needCount})` },
            } : {
                title: 'Track your applications',
                text: 'Follow progress in Batches; replies, assessments and interview invites land in your Inbox.',
                cta: { to: '/autoapply', label: 'Open batches' },
            },
        }

        const currentIdx = GUIDE_STEPS.findIndex((s) => !done[s.id])
        const steps = GUIDE_STEPS.map((s, i) => ({
            ...s,
            ...copy[s.id],
            state: done[s.id] ? 'done' : i === currentIdx ? 'current' : 'locked',
        }))
        const current = steps[currentIdx] || null
        return {
            ready,
            eligible: !!d.eligible,
            steps,
            current,
            doneCount: steps.filter((s) => s.state === 'done').length,
            total: steps.length,
        }
    }, [me.data, batchesQ.data, needsQ.data, answersQ.data, ready])
}

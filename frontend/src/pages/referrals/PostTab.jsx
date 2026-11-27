import { useRef, useState } from 'react'
import { FileText, Send, Upload, X } from 'lucide-react'
import { ApiError, isUsageLimit } from '../../lib/apiClient'
import { LockedPanel } from '../../components/shared/PaywallGate'
import { ErrorState, LimitReached } from '../../components/shared/states'
import CompanyAutocomplete from '../../components/shared/CompanyAutocomplete'
import { Button } from '../../components/ui'
import { EVENTS, track } from '../../lib/analytics'
import { track as trackUi, TRACK } from '../../lib/track'
import { useMyReferrals, usePostReferral } from '../../lib/useReferrals'
import { QuotaPill } from './Chips'
import { getSection } from '../../lib/sections'

const TONE = getSection('referrals').tone

// ── Tab: Ask for a referral ───────────────────────────────────────
// One short form. The Send button sits in a sticky bar above the bottom nav.
export default function PostTab({ limits, onPosted }) {
    const monthlyLimit = limits?.referral_requests_per_month
    const mine = useMyReferrals()
    const post = usePostReferral()
    const fileRef = useRef(null)

    const [company, setCompany] = useState('')
    const [jobId, setJobId] = useState('')
    const [jobTitle, setJobTitle] = useState('')
    const [resumeFile, setResumeFile] = useState(null)
    const [formErr, setFormErr] = useState(null)
    const [limitErr, setLimitErr] = useState(null)
    const [openExists, setOpenExists] = useState(false)

    if (monthlyLimit === 0) {
        return (
            <LockedPanel
                feature="referral_request"
                title="Referral requests need Pro"
                subtitle="Upgrade to ask employees to refer you."
            />
        )
    }

    const clearFile = () => {
        setResumeFile(null)
        if (fileRef.current) fileRef.current.value = ''
    }

    const submit = async (e) => {
        e.preventDefault()
        trackUi(TRACK.CTA_CLICK, { id: 'referral_send', section: 'referrals' })
        setFormErr(null)
        setLimitErr(null)
        setOpenExists(false)

        if (!company.trim()) { setFormErr({ message: 'Enter the company.' }); return }
        if (!resumeFile) { setFormErr({ message: 'Attach your resume PDF.' }); return }

        const fd = new FormData()
        fd.append('target_company', company.trim())
        if (jobId.trim()) fd.append('job_id', jobId.trim())
        if (jobTitle.trim()) fd.append('job_title', jobTitle.trim())
        fd.append('resume', resumeFile)

        try {
            await post.mutateAsync(fd)
            // No PII — only the company string and whether a job id was attached.
            track(EVENTS.REFERRAL_REQUEST_POSTED, {
                target_company: company.trim(),
                has_job_id: !!jobId.trim(),
            })
            setCompany('')
            setJobId('')
            setJobTitle('')
            clearFile()
            onPosted()
        } catch (err) {
            if (isUsageLimit(err)) {
                setLimitErr({ used: err.used, limit: err.limit, resetsAt: err.resetsAt })
            } else if (err instanceof ApiError && err.code === 'open_request_exists') {
                setOpenExists(true)
            } else {
                setFormErr(err)
            }
        }
    }

    const usage = mine.data?.usage

    return (
        <form onSubmit={submit} className="rf-form" noValidate>
            {usage && (
                <div className="rf-quota">
                    <span>This month</span>
                    <QuotaPill usage={usage} />
                </div>
            )}

            <div className="sys-field">
                <label className="sys-field-label" htmlFor="ref-company">Company</label>
                <CompanyAutocomplete id="ref-company" value={company} onChange={setCompany} />
            </div>

            <div className="sys-field">
                <label className="sys-field-label" htmlFor="ref-job-title">Role <span className="rf-optional">(optional)</span></label>
                <input
                    id="ref-job-title"
                    className="input-field"
                    placeholder="e.g. Backend Engineer"
                    autoComplete="off"
                    value={jobTitle}
                    onChange={(e) => setJobTitle(e.target.value)}
                />
            </div>

            <div className="sys-field">
                <label className="sys-field-label" htmlFor="ref-job-id">Job ID <span className="rf-optional">(optional)</span></label>
                <input
                    id="ref-job-id"
                    className="input-field"
                    placeholder="e.g. R-123456"
                    autoComplete="off"
                    value={jobId}
                    onChange={(e) => setJobId(e.target.value)}
                />
            </div>

            <div className="sys-field">
                <span className="sys-field-label" id="ref-resume-label">Resume PDF</span>
                {resumeFile ? (
                    <div className="ref-file">
                        <FileText size={16} aria-hidden="true" />
                        <span title={resumeFile.name}>{resumeFile.name}</span>
                        <Button variant="ghost" iconOnly icon={X} aria-label="Remove resume" onClick={clearFile} />
                    </div>
                ) : (
                    <button type="button" className="ref-drop" aria-labelledby="ref-resume-label ref-resume-hint"
                        onClick={() => fileRef.current?.click()}>
                        <Upload size={20} aria-hidden="true" />
                        <span>Upload your resume</span>
                        <span className="ref-drop-hint" id="ref-resume-hint">PDF only · max 10MB</span>
                    </button>
                )}
                <input
                    ref={fileRef}
                    type="file"
                    accept=".pdf"
                    hidden
                    onChange={(e) => setResumeFile(e.target.files[0] || null)}
                />
            </div>

            {openExists && (
                <p className="sys-note is-warn" role="alert">
                    You already have an open request. Cancel it in Mine first.
                </p>
            )}

            {limitErr && (
                <LimitReached
                    feature="referral_request"
                    used={limitErr.used}
                    limit={limitErr.limit}
                    resetsAt={limitErr.resetsAt}
                />
            )}

            {formErr && <ErrorState compact err={formErr} />}

            <div className="rf-sendbar" style={{ '--tone': TONE }}>
                <button type="submit" className="sys-tone-btn is-block" disabled={post.isPending} aria-busy={post.isPending || undefined}>
                    {post.isPending ? <span className="sys-spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
                    <span>{post.isPending ? 'Sending…' : 'Send request'}</span>
                </button>
            </div>
        </form>
    )
}

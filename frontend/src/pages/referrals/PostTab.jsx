import { useRef, useState } from 'react'
import { FileText, Upload, X } from 'lucide-react'
import { ApiError, isUsageLimit } from '../../lib/apiClient'
import { LockedPanel } from '../../components/shared/PaywallGate'
import { ErrorState, LimitReached } from '../../components/shared/states'
import CompanyAutocomplete from '../../components/shared/CompanyAutocomplete'
import { Button } from '../../components/ui'
import { EVENTS, track } from '../../lib/analytics'
import { useMyReferrals, usePostReferral } from '../../lib/useReferrals'
import { QuotaLine } from './Chips'

// ── Tab: Post a request ────────────────────────────────────────────
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
                title="Referral requests are a Pro feature"
                subtitle="Upgrade to ask verified employees at a company to refer you."
            />
        )
    }

    const clearFile = () => {
        setResumeFile(null)
        if (fileRef.current) fileRef.current.value = ''
    }

    const submit = async (e) => {
        e.preventDefault()
        setFormErr(null)
        setLimitErr(null)
        setOpenExists(false)

        if (!company.trim()) { setFormErr({ message: 'Enter the target company.' }); return }
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
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="form-group">
                <label className="field-label" htmlFor="ref-company">Target company</label>
                <CompanyAutocomplete id="ref-company" value={company} onChange={setCompany} />
                <p className="field-hint">Pick one or type a new company.</p>
            </div>

            <div className="form-group">
                <label className="field-label" htmlFor="ref-job-id">Job ID <span className="ref-optional">(optional)</span></label>
                <input
                    id="ref-job-id"
                    className="input-field"
                    placeholder="e.g. R-123456"
                    value={jobId}
                    onChange={(e) => setJobId(e.target.value)}
                />
            </div>

            <div className="form-group">
                <label className="field-label" htmlFor="ref-job-title">Job title <span className="ref-optional">(optional)</span></label>
                <input
                    id="ref-job-title"
                    className="input-field"
                    placeholder="e.g. Senior Backend Engineer"
                    value={jobTitle}
                    onChange={(e) => setJobTitle(e.target.value)}
                />
            </div>

            <div className="form-group">
                <span className="field-label" id="ref-resume-label">Resume PDF</span>
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
                    style={{ display: 'none' }}
                    onChange={(e) => setResumeFile(e.target.files[0] || null)}
                />
            </div>

            {usage && <QuotaLine usage={usage} />}

            {openExists && (
                <div className="sys-note is-warn" role="alert">
                    You already have an open request. Cancel it from “My requests” first.
                </div>
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

            <button type="submit" className="primary-btn" disabled={post.isPending}>
                <span>{post.isPending ? 'Posting…' : 'Post referral request'}</span>
                {post.isPending && <div className="spinner" />}
            </button>
        </form>
    )
}

import { useEffect, useRef, useState } from 'react'
import { FileText, Upload, X, Sparkles } from 'lucide-react'
import Navbar from '../components/Navbar'
import { useEntitlements } from '../lib/useEntitlements'
import { apiFetch, isUsageLimit } from '../lib/apiClient'
import { LockedPanel, UsageMeter } from '../components/shared/PaywallGate'
import { LimitReached, errorText } from '../components/shared/states'
import { PageContainer, Card } from '../components/shared/Layout'
import { SectionHead, Button, PageHeader } from '../components/ui'
import { TERMS } from '../lib/copy'
import { Expander } from '../components/interview/CollapsibleMarkdown'
import { track, EVENTS } from '../lib/analytics'

// Score -> semantic tone (ring + number colour).
const scoreTone = (v) => (v >= 75 ? 'success' : v >= 50 ? 'waiting' : 'danger')

function ScoreRing({ label, value }) {
    const circleRef = useRef(null)
    const CIRCUMFERENCE = 2 * Math.PI * 34

    useEffect(() => {
        const fg = circleRef.current
        if (!fg) return
        fg.style.transition = 'none'
        fg.style.strokeDashoffset = CIRCUMFERENCE
        void fg.getBoundingClientRect()
        fg.style.transition = 'stroke-dashoffset 1.2s cubic-bezier(.4,0,.2,1)'
        fg.style.strokeDashoffset = CIRCUMFERENCE * (1 - value / 100)
    }, [value, CIRCUMFERENCE])

    return (
        <div className={`score-card opt-score tone-${scoreTone(value)}`}>
            <div className="score-ring" role="img" aria-label={`${label}: ${value}%`}>
                <svg viewBox="0 0 80 80" aria-hidden="true">
                    <circle className="ring-bg" cx="40" cy="40" r="34" />
                    <circle ref={circleRef} className="ring-fg" cx="40" cy="40" r="34" />
                </svg>
                <span className="score-value" aria-hidden="true">{value}%</span>
            </div>
            <div className="score-label">{label}</div>
        </div>
    )
}

function ScoreGrid({ metrics, short = false }) {
    return (
        <div className="score-grid opt-scores">
            <ScoreRing label={short ? 'Keywords' : 'Keyword match'} value={metrics.keywordMatchPercent ?? 0} />
            <ScoreRing label="ATS pass" value={metrics.atsPassChancePercent ?? 0} />
            <ScoreRing label={short ? 'Human' : 'Human screen'} value={metrics.humanScreenChancePercent ?? 0} />
        </div>
    )
}

function ScorePanel({ title, metrics, tone }) {
    if (!metrics) return null
    return (
        <div className={`opt-panel sys-seg tone-${tone}`}>
            <h3 className="opt-panel-title tone-text">{title}</h3>
            <ScoreGrid metrics={metrics} short />
        </div>
    )
}

export default function HomePage() {
    const { limits } = useEntitlements()
    const resumeLimit = limits.resume_optimizer_per_month
    const resumeLocked = !(resumeLimit > 0)
    const [provider, setProvider] = useState('gemini')
    const [resumeFile, setResumeFile] = useState(null)
    const [jd, setJd] = useState('')
    const [name, setName] = useState('')
    const [companyName, setCompanyName] = useState('')
    const [loading, setLoading] = useState(false)
    const [status, setStatus] = useState({ msg: '', type: '' })
    const [results, setResults] = useState(null)
    const [limitInfo, setLimitInfo] = useState(null)
    const fileInputRef = useRef(null)

    // Validation
    const missingFile = !resumeFile
    const missingJd = !jd.trim()
    const canSubmit = !missingFile && !missingJd && !loading

    const validationMsg = () => {
        if (missingFile && missingJd) return 'Upload a resume PDF and paste a job description to continue.'
        if (missingFile) return 'Upload a resume PDF to continue.'
        if (missingJd) return 'Paste a job description to continue.'
        return ''
    }

    const handleGenerate = async () => {
        if (!canSubmit) return
        trackUi(TRACK.CTA_CLICK, { id: 'resume_generate', section: 'prepare' })

        setLoading(true)
        setResults(null)
        setLimitInfo(null)
        setStatus({ msg: `Tailoring resume with ${provider}… 15–30 s`, type: '' })

        track(EVENTS.RESUME_OPTIMIZER_STARTED, { provider })

        try {
            const form = new FormData()
            form.append('resume', resumeFile)
            form.append('jd', jd)
            form.append('provider', provider)
            if (name.trim()) form.append('name', name.trim())
            if (companyName.trim()) form.append('companyName', companyName.trim())

            const data = await apiFetch('/api/generate', { formData: form, timeout: 180_000 })

            downloadPdf(data.pdfBase64, data.filename)
            setResults({ metrics: data.metrics, beforeMetrics: data.beforeMetrics, filename: data.filename })
            track(EVENTS.RESUME_OPTIMIZER_COMPLETED, {
                provider,
                keyword_match: data?.metrics?.keywordMatchPercent ?? null,
                ats: data?.metrics?.atsPassChancePercent ?? null,
            })
            setStatus({ msg: `Done! Downloaded as ${data.filename}`, type: 'ok' })
        } catch (err) {
            if (isUsageLimit(err)) {
                setLimitInfo({ used: err.used, limit: err.limit, resetsAt: err.resetsAt })
                setStatus({ msg: '', type: '' })
            } else {
                setStatus({ msg: errorText(err), type: 'error' })
            }
        } finally {
            setLoading(false)
        }
    }

    // Cosmetic hint only — the real download uses `data.filename` from the API,
    // which is `First_Last_Resume_Company.pdf` (name derived from the uploaded
    // résumé when the form name is blank). Mirror the server's slug: keep word
    // chars + hyphens, drop other punctuation, whitespace runs → "_".
    const slugPart = v => v.trim().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_')
    const companyPart = companyName.trim() ? slugPart(companyName) : 'Company'
    const filenamePreview = name.trim()
        ? `${slugPart(name)}_Resume_${companyPart}.pdf`
        : `<name from your résumé>_Resume_${companyPart}.pdf`

    const hint = validationMsg()
    const clearFile = () => { setResumeFile(null); if (fileInputRef.current) fileInputRef.current.value = '' }

    const body = (
        <>
            {Number.isFinite(resumeLimit) && <UsageMeter feature="resume_optimizer" />}

            <Card className="opt-form">
                {/* Resume upload */}
                <div className="sys-field">
                    <span className="sys-field-label" id="opt-resume-l">Resume PDF</span>
                    {resumeFile ? (
                        <div className="opt-file tone-active" aria-labelledby="opt-resume-l">
                            <FileText size={16} aria-hidden="true" />
                            <span className="opt-file-name">{resumeFile.name}</span>
                            <Button variant="ghost" iconOnly icon={X} aria-label="Remove resume" onClick={clearFile} />
                        </div>
                    ) : (
                        <button type="button" className="opt-drop" aria-labelledby="opt-resume-l" onClick={() => fileInputRef.current?.click()}>
                            <Upload size={18} aria-hidden="true" />
                            <span>Upload your resume <small>(PDF)</small></span>
                        </button>
                    )}
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf"
                        hidden
                        onChange={e => setResumeFile(e.target.files[0] || null)}
                    />
                </div>

                {/* Job description */}
                <div className="sys-field">
                    <label className="sys-field-label" htmlFor="opt-jd">Job description</label>
                    <textarea
                        id="opt-jd"
                        className="input-field"
                        placeholder="Paste the full job description…"
                        rows={9}
                        value={jd}
                        onChange={e => setJd(e.target.value)}
                    />
                </div>

                {/* Name + company (filename only): optional, so collapsed */}
                <Expander title="File name (optional)">
                <div className="opt-row">
                    <div className="sys-field">
                        <label className="sys-field-label" htmlFor="opt-name">Your name</label>
                        <input id="opt-name" className="input-field" placeholder="e.g. Alex Morgan" value={name} onChange={e => setName(e.target.value)} />
                    </div>
                    <div className="sys-field">
                        <label className="sys-field-label" htmlFor="opt-company">Company</label>
                        <input id="opt-company" className="input-field" placeholder="e.g. Google" value={companyName} onChange={e => setCompanyName(e.target.value)} />
                    </div>
                </div>
                <p className="opt-filename">File: <code>{filenamePreview}</code></p>
                </Expander>

                <Button variant="primary" size="lg" block icon={Sparkles} onClick={handleGenerate} disabled={!canSubmit}
                    busy={loading} busyLabel="Generating…">
                    Generate &amp; download
                </Button>

                <div aria-live="polite" className="opt-status">
                    {hint && !loading && !status.msg && <p className="opt-hint">{hint}</p>}
                    {status.msg && (
                        <p className={`sys-note ${status.type === 'error' ? 'is-danger' : status.type === 'ok' ? 'is-ok' : 'is-info'}`}>{status.msg}</p>
                    )}
                </div>
            </Card>

            {/* Monthly limit reached (server 402) */}
            {limitInfo && (
                <LimitReached
                    feature="resume_optimizer"
                    used={limitInfo.used}
                    limit={limitInfo.limit}
                    resetsAt={limitInfo.resetsAt}
                />
            )}

            {/* Results scorecard */}
            {results && (
                <section className="results opt-results" aria-labelledby="opt-results-h">
                    <SectionHead title="Match scorecard" tone="success" id="opt-results-h" />

                    {results.beforeMetrics ? (
                        <div className="opt-pair">
                            <ScorePanel title="Before" metrics={results.beforeMetrics} tone="history" />
                            <ScorePanel title="After" metrics={results.metrics} tone="plan" />
                        </div>
                    ) : (
                        <ScoreGrid metrics={results.metrics} />
                    )}

                    <Card className="opt-details">
                        <h3 className="opt-subhead">Matched keywords</h3>
                        <div className="sys-chips">
                            {(results.metrics.matchedKeywords || []).map((k, i) => <span key={i} className="sys-chip is-toned tone-success">{k}</span>)}
                        </div>

                        <h3 className="opt-subhead">Missing keywords</h3>
                        <div className="sys-chips">
                            {(results.metrics.missingRequiredKeywords || []).map((k, i) => <span key={i} className="sys-chip is-toned tone-danger">{k}</span>)}
                        </div>

                        <h3 className="opt-subhead">Hard gaps</h3>
                        <ul id="hardGaps" className="opt-list">
                            {(results.metrics.hardGaps?.length ? results.metrics.hardGaps : ['No hard gaps flagged.']).map((g, i) => (
                                <li key={i}>{g}</li>
                            ))}
                        </ul>

                        {results.metrics.notes && (
                            <>
                                <h3 className="opt-subhead">Notes</h3>
                                <p id="notes" className="opt-notes">{results.metrics.notes}</p>
                            </>
                        )}

                        <p className="opt-filename">Downloaded as <code>{results.filename}</code></p>
                    </Card>
                </section>
            )}
        </>
    )

    return (
        <>
            <Navbar />
            <PageContainer width="sm">
                <PageHeader section="prepare" title={TERMS.resumeCheck.one} subtitle="Tailor your resume to one job" back={{ to: '/prepare', label: 'Prepare' }} />

                {resumeLocked ? (
                    <LockedPanel
                        feature="resume_optimizer"
                        title="Resume check needs Pro"
                        subtitle="Upgrade to tailor your resume to any job."
                    />
                ) : body}
            </PageContainer>
        </>
    )
}

function downloadPdf(base64, filename) {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    const blob = new Blob([bytes], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const a = Object.assign(document.createElement('a'), { href: url, download: filename })
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
}

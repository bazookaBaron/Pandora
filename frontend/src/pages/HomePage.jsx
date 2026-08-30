import { useEffect, useRef, useState } from 'react'
import Navbar from '../components/Navbar'
import { useMediaQuery } from '../lib/useMediaQuery'
import { useEntitlements } from '../lib/useEntitlements'
import { apiFetch, isUsageLimit } from '../lib/apiClient'
import { LockedPanel, UsageMeter } from '../components/shared/PaywallGate'
import { LimitReached, errorText } from '../components/shared/states'
import { track, EVENTS } from '../lib/analytics'

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
        <div className="score-card">
            <div className="score-ring">
                <svg viewBox="0 0 80 80">
                    <circle className="ring-bg" cx="40" cy="40" r="34" />
                    <circle ref={circleRef} className="ring-fg" cx="40" cy="40" r="34" />
                </svg>
                <span className="score-value">{value}%</span>
            </div>
            <div className="score-label">{label}</div>
        </div>
    )
}

// On narrow screens drop the 3-up ring grid to 2-up so 80px rings stay readable
// without overflowing a stacked panel. (index.css keeps it 3-up otherwise.)
const denseGrid = { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', justifyItems: 'center', gap: 8 }

function ScorePanel({ title, metrics, accent, isMobile }) {
    if (!metrics) return null
    return (
        <div style={{
            flex: 1, minWidth: 0, background: 'var(--panel)', border: `1px solid ${accent}33`,
            borderRadius: 10, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10,
        }}>
            <h3 style={{ fontSize: '0.72rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em', color: accent, margin: 0 }}>
                {title}
            </h3>
            <div className="score-grid" style={{ margin: 0, ...(isMobile ? denseGrid : null) }}>
                <ScoreRing label="Keyword Match" value={metrics.keywordMatchPercent ?? 0} />
                <ScoreRing label="ATS Pass" value={metrics.atsPassChancePercent ?? 0} />
                <ScoreRing label="Human Screen" value={metrics.humanScreenChancePercent ?? 0} />
            </div>
        </div>
    )
}

export default function HomePage() {
    const { limits } = useEntitlements()
    const resumeLimit = limits.resume_optimizer_per_month
    const resumeLocked = !(resumeLimit > 0)
    const isMobile = useMediaQuery('(max-width: 767px)')
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

            const data = await apiFetch('/api/generate', { formData: form })

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

    const body = (
        <>
            {Number.isFinite(resumeLimit) && <UsageMeter feature="resume_optimizer" />}

            {/* Name + Company row */}
            <section className="card" style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
                <div>
                    <label className="field-label">Your Name <span style={{ color: 'var(--faint)', fontWeight: 400 }}>(for filename)</span></label>
                    <input
                        className="input-field"
                        style={{ padding: '10px 12px', borderRadius: 6, width: '100%', boxSizing: 'border-box', fontSize: '0.9rem' }}
                        placeholder="e.g. Alex Morgan"
                        value={name}
                        onChange={e => setName(e.target.value)}
                    />
                </div>
                <div>
                    <label className="field-label">Target Company <span style={{ color: 'var(--faint)', fontWeight: 400 }}>(for filename)</span></label>
                    <input
                        className="input-field"
                        style={{ padding: '10px 12px', borderRadius: 6, width: '100%', boxSizing: 'border-box', fontSize: '0.9rem' }}
                        placeholder="e.g. Google"
                        value={companyName}
                        onChange={e => setCompanyName(e.target.value)}
                    />
                </div>
                <p style={{ gridColumn: '1/-1', margin: 0, fontSize: '0.7rem', color: 'var(--faint)', overflowWrap: 'anywhere' }}>
                    Downloaded file will be named: <code style={{ color: '#a78bfa' }}>{filenamePreview}</code>
                </p>
            </section>

            {/* Resume Upload */}
            <section className="card">
                <label className="field-label">Resume PDF</label>
                <div
                    onClick={() => fileInputRef.current?.click()}
                    style={{
                        border: `2px dashed ${resumeFile ? '#22d3ee' : 'var(--subtle)'}`,
                        borderRadius: 8, padding: '20px 16px', textAlign: 'center',
                        cursor: 'pointer', transition: 'border-color 0.2s',
                        background: resumeFile ? 'rgba(34,211,238,0.04)' : 'transparent',
                    }}
                    onMouseEnter={e => { if (!resumeFile) e.currentTarget.style.borderColor = 'var(--subtle-strong)' }}
                    onMouseLeave={e => { if (!resumeFile) e.currentTarget.style.borderColor = 'var(--subtle)' }}
                >
                    {resumeFile ? (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                            <span style={{ color: '#22d3ee', fontSize: '0.85rem', fontWeight: 700, overflowWrap: 'anywhere' }}>{resumeFile.name}</span>
                            <button
                                type="button"
                                onClick={e => { e.stopPropagation(); setResumeFile(null); if (fileInputRef.current) fileInputRef.current.value = '' }}
                                style={{ background: 'none', border: 'none', color: 'var(--faint)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}
                            >×</button>
                        </div>
                    ) : (
                        <>
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#52525b" strokeWidth="1.5" style={{ marginBottom: 8 }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                            <p style={{ color: 'var(--muted)', fontSize: '0.85rem', margin: 0 }}>Click to upload your resume PDF</p>
                            <p style={{ color: 'var(--faint)', fontSize: '0.72rem', margin: '4px 0 0' }}>PDF only</p>
                        </>
                    )}
                </div>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf"
                    style={{ display: 'none' }}
                    onChange={e => setResumeFile(e.target.files[0] || null)}
                />
            </section>

            {/* JD Input */}
            <section className="card">
                <label className="field-label">Job Description</label>
                <textarea
                    className="input-field"
                    style={{ maxWidth: '100%' }}
                    placeholder="Paste the full job description here…"
                    rows={12}
                    value={jd}
                    onChange={e => setJd(e.target.value)}
                />
            </section>

            {/* Inline validation */}
            {validationMsg() && !loading && (
                <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 8, textAlign: 'center' }}>
                    {validationMsg()}
                </p>
            )}

            {/* Generate Button */}
            <button className="primary-btn" onClick={handleGenerate} disabled={!canSubmit}>
                <svg className="btn-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                <span>{loading ? 'Generating…' : 'Generate & Download Resume'}</span>
                {loading && <div className="spinner" />}
            </button>

            {/* Status */}
            <div className={`status${status.type ? ` ${status.type}` : ''}`}>{status.msg}</div>

            {/* Monthly limit reached (server 402) */}
            {limitInfo && (
                <LimitReached
                    feature="resume_optimizer"
                    used={limitInfo.used}
                    limit={limitInfo.limit}
                    resetsAt={limitInfo.resetsAt}
                />
            )}

            {/* Results Scorecard */}
            {results && (
                <section className="results">
                    <h2 className="section-title">Match Scorecard</h2>

                    {/* Before / After side-by-side */}
                    {results.beforeMetrics ? (
                        <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                            <ScorePanel title="Before Optimization" metrics={results.beforeMetrics} accent="#71717a" isMobile={isMobile} />
                            <ScorePanel title="After Optimization" metrics={results.metrics} accent="#a78bfa" isMobile={isMobile} />
                        </div>
                    ) : (
                        <div className="score-grid" style={isMobile ? denseGrid : undefined}>
                            <ScoreRing label="Keyword Match" value={results.metrics.keywordMatchPercent ?? 0} />
                            <ScoreRing label="ATS Pass Chance" value={results.metrics.atsPassChancePercent ?? 0} />
                            <ScoreRing label="Human Screen" value={results.metrics.humanScreenChancePercent ?? 0} />
                        </div>
                    )}

                    <div className="detail-block card">
                        <h3>Matched Keywords</h3>
                        <div className="pill-list">
                            {(results.metrics.matchedKeywords || []).map((k, i) => <span key={i}>{k}</span>)}
                        </div>
                    </div>

                    <div className="detail-block card">
                        <h3>Missing Required Keywords</h3>
                        <div className="pill-list pill-missing">
                            {(results.metrics.missingRequiredKeywords || []).map((k, i) => <span key={i}>{k}</span>)}
                        </div>
                    </div>

                    <div className="detail-block card">
                        <h3>Hard Gaps</h3>
                        <ul id="hardGaps">
                            {(results.metrics.hardGaps?.length ? results.metrics.hardGaps : ['No hard gaps flagged.']).map((g, i) => (
                                <li key={i}>{g}</li>
                            ))}
                        </ul>
                    </div>

                    <div className="detail-block card">
                        <h3>Notes</h3>
                        <p id="notes">{results.metrics.notes}</p>
                    </div>

                    <div className="detail-block card">
                        <p className="filename-line" style={{ overflowWrap: 'anywhere' }}>Downloaded as: <code>{results.filename}</code></p>
                    </div>
                </section>
            )}
        </>
    )

    return (
        <>
            <Navbar />
            <main className="wrap">
                {/* Header */}
                <header className="header">
                    <div>
                        <h1>Resume Optimizer</h1>
                        <p className="subtitle">Upload your resume PDF + paste a job description → get a tailored, ATS-optimized PDF in seconds.</p>
                    </div>
                </header>

                {resumeLocked ? (
                    <LockedPanel
                        feature="resume_optimizer"
                        title="Resume Optimizer is a Pro feature"
                        subtitle="Upgrade to tailor your resume to any JD."
                    />
                ) : body}
            </main>
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

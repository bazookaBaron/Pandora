import { useEffect, useRef, useState } from 'react'
import Navbar from '../components/Navbar'

const PLACEHOLDERS = {
    anthropic: 'sk-ant-api03-…',
    openai: 'sk-proj-…',
    gemini: 'AIzaSy…',
}

// ── Score ring SVG defs (injected once) ───────────────────────────
function RingDefs() {
    return (
        <svg width="0" height="0" style={{ position: 'absolute' }}>
            <defs>
                <linearGradient id="ring-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#818cf8" />
                    <stop offset="100%" stopColor="#c084fc" />
                </linearGradient>
            </defs>
        </svg>
    )
}

function ScoreRing({ id, label, value }) {
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

export default function HomePage() {
    const [provider, setProvider] = useState('anthropic')
    const [apiKey, setApiKey] = useState('')
    const [showKey, setShowKey] = useState(false)
    const [jd, setJd] = useState('')
    const [loading, setLoading] = useState(false)
    const [status, setStatus] = useState({ msg: '', type: '' })
    const [results, setResults] = useState(null)

    // Persist provider/key across sessions
    useEffect(() => {
        const savedProv = sessionStorage.getItem('resumeOpt_provider')
        const savedKey = sessionStorage.getItem('resumeOpt_apiKey')
        if (savedProv) setProvider(savedProv)
        if (savedKey) setApiKey(savedKey)
    }, [])

    const handleProviderChange = (val) => {
        setProvider(val)
        setApiKey('')
        sessionStorage.setItem('resumeOpt_provider', val)
        sessionStorage.removeItem('resumeOpt_apiKey')
    }

    const handleKeyChange = (val) => {
        setApiKey(val)
        sessionStorage.setItem('resumeOpt_apiKey', val)
    }

    const handleGenerate = async () => {
        if (!apiKey.trim()) { setStatus({ msg: 'Enter your API key above.', type: 'error' }); return }
        if (!jd.trim()) { setStatus({ msg: 'Paste a job description first.', type: 'error' }); return }

        setLoading(true)
        setResults(null)
        setStatus({ msg: `Tailoring resume with ${provider}… 15-30 s`, type: '' })

        try {
            const res = await fetch('/api/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jd, apiKey, provider }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Generation failed.')

            downloadPdf(data.pdfBase64, data.filename)
            setResults({ metrics: data.metrics, filename: data.filename })
            setStatus({ msg: `Done! Downloaded as ${data.filename}`, type: 'ok' })
        } catch (err) {
            setStatus({ msg: err.message, type: 'error' })
        } finally {
            setLoading(false)
        }
    }

    return (
        <>
            <Navbar />
            <RingDefs />
            <div className="bg-blob blob-1" />
            <div className="bg-blob blob-2" />
            <div className="bg-blob blob-3" />

            <main className="wrap">
                {/* Header */}
                <header className="header">
                    <div className="logo-mark">
                        <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                            <rect width="32" height="32" rx="8" fill="url(#logo-home)" />
                            <path d="M10 22V10h4l4 7 4-7h4v12h-3.5v-7.5L19 19h-2.5l-3.5-4.5V22H10z" fill="white" />
                            <defs>
                                <linearGradient id="logo-home" x1="0" y1="0" x2="32" y2="32">
                                    <stop stopColor="#6366f1" /><stop offset="1" stopColor="#a855f7" />
                                </linearGradient>
                            </defs>
                        </svg>
                    </div>
                    <div>
                        <h1>Resume Optimizer</h1>
                        <p className="subtitle">Paste a job description → get a tailored, ATS-optimized PDF in seconds.</p>
                    </div>
                </header>

                {/* AI Provider + Key */}
                <section className="card api-key-section">
                    <label className="field-label">
                        <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" style={{ verticalAlign: '-2px', marginRight: 6, opacity: .6 }}>
                            <path d="M8 1a4 4 0 0 0-4 4v3H3a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-1V5a4 4 0 0 0-4-4zm2.5 7h-5V5a2.5 2.5 0 1 1 5 0v3z" />
                        </svg>
                        AI Provider &amp; API Key
                    </label>

                    <div className="provider-row">
                        <select
                            className="input-field provider-select"
                            value={provider}
                            onChange={e => handleProviderChange(e.target.value)}
                        >
                            <option value="anthropic">Anthropic — Claude Sonnet 4</option>
                            <option value="openai">OpenAI — GPT-4o Mini</option>
                            <option value="gemini">Google — Gemini 3.6 Flash</option>
                        </select>
                    </div>

                    <div className="api-key-row">
                        <input
                            type={showKey ? 'text' : 'password'}
                            className="input-field api-key-input"
                            placeholder={PLACEHOLDERS[provider]}
                            value={apiKey}
                            onChange={e => handleKeyChange(e.target.value)}
                            autoComplete="off"
                        />
                        <button type="button" className="icon-btn" onClick={() => setShowKey(v => !v)}>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                {showKey
                                    ? <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" /></>
                                    : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>
                                }
                            </svg>
                        </button>
                    </div>
                    <p className="field-hint">Your key stays in the browser — never stored on the server.</p>
                </section>

                {/* JD Input */}
                <section className="card">
                    <label className="field-label">Job Description</label>
                    <textarea
                        className="input-field"
                        placeholder="Paste the full job description here…"
                        rows={12}
                        value={jd}
                        onChange={e => setJd(e.target.value)}
                    />
                </section>

                {/* Generate Button */}
                <button className="primary-btn" onClick={handleGenerate} disabled={loading}>
                    <svg className="btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                    </svg>
                    <span>{loading ? 'Generating…' : 'Generate & Download Resume'}</span>
                    {loading && <div className="spinner" />}
                </button>

                {/* Status */}
                <div className={`status${status.type ? ` ${status.type}` : ''}`}>{status.msg}</div>

                {/* Results Scorecard */}
                {results && (
                    <section className="results">
                        <h2 className="section-title">Match Scorecard</h2>
                        <div className="score-grid">
                            <ScoreRing id="keyword" label="Keyword Match" value={results.metrics.keywordMatchPercent ?? 0} />
                            <ScoreRing id="ats" label="ATS Pass Chance" value={results.metrics.atsPassChancePercent ?? 0} />
                            <ScoreRing id="human" label="Human Screen" value={results.metrics.humanScreenChancePercent ?? 0} />
                        </div>

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
                            <p className="filename-line">Downloaded as: <code>{results.filename}</code></p>
                        </div>
                    </section>
                )}
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

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Navbar from '../../components/Navbar'
import { useEntitlements } from '../../lib/useEntitlements'
import { ApiError, isUsageLimit } from '../../lib/apiClient'
import { LockedPanel } from '../../components/shared/PaywallGate'
import { EmptyState, ErrorState, LimitReached, LoadingState, errorText } from '../../components/shared/states'
import { EVENTS, track } from '../../lib/analytics'
import {
    fetchResumeUrl,
    useAcceptReferral,
    useCancelReferral,
    useCompanyOptions,
    useMyReferrals,
    useOpenReferrals,
    usePostReferral,
} from '../../lib/useReferrals'

// ── Small helpers ──────────────────────────────────────────────────
function relTime(iso) {
    if (!iso) return ''
    const then = new Date(iso).getTime()
    if (Number.isNaN(then)) return ''
    const diff = then - Date.now()
    const past = diff < 0
    const s = Math.abs(diff) / 1000
    let core
    if (s < 60) return 'just now'
    if (s < 3600) core = Math.round(s / 60) + 'm'
    else if (s < 86400) core = Math.round(s / 3600) + 'h'
    else core = Math.round(s / 86400) + 'd'
    return past ? core + ' ago' : 'in ' + core
}

function fmtDate(iso) {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function isUnlimited(limit) {
    return limit === 'unlimited' || limit === Infinity || !Number.isFinite(Number(limit))
}

// ── Company autocomplete (free-text allowed) ───────────────────────
function CompanyAutocomplete({ value, onChange, placeholder = 'Start typing a company…', id }) {
    const [open, setOpen] = useState(false)
    const [debounced, setDebounced] = useState(value || '')
    const boxRef = useRef(null)

    useEffect(() => {
        const t = setTimeout(() => setDebounced(value || ''), 200)
        return () => clearTimeout(t)
    }, [value])

    useEffect(() => {
        const onDoc = (e) => {
            if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDoc)
        return () => document.removeEventListener('mousedown', onDoc)
    }, [])

    const { data } = useCompanyOptions(debounced)
    const typed = (value || '').trim().toLowerCase()
    const options = (data?.companies || []).filter((c) => c.toLowerCase() !== typed)

    return (
        <div ref={boxRef} style={{ position: 'relative' }}>
            <input
                id={id}
                type="text"
                className="input-field"
                autoComplete="off"
                placeholder={placeholder}
                value={value}
                onChange={(e) => { onChange(e.target.value); setOpen(true) }}
                onFocus={() => setOpen(true)}
            />
            {open && options.length > 0 && (
                <div style={{
                    position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
                    background: '#18181b', border: '1px solid #27272a', borderRadius: 6,
                    maxHeight: 220, overflowY: 'auto', zIndex: 50,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                }}>
                    {options.map((c) => (
                        <div
                            key={c}
                            onMouseDown={(e) => { e.preventDefault(); onChange(c); setOpen(false) }}
                            style={{
                                padding: '7px 12px', cursor: 'pointer', fontSize: '0.82rem',
                                color: '#a1a1aa', borderBottom: '1px solid rgba(39,39,42,0.5)',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = '#27272a'; e.currentTarget.style.color = '#fafafa' }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#a1a1aa' }}
                        >
                            {c}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

// ── Shared bits ────────────────────────────────────────────────────
function QuotaLine({ usage }) {
    if (!usage) return null
    const unlimited = isUnlimited(usage.limit)
    return (
        <div style={{
            background: '#18181b', border: '1px solid #27272a', borderRadius: 8,
            padding: '10px 14px', fontSize: '0.76rem', color: '#a1a1aa', fontWeight: 700,
        }}>
            {unlimited
                ? 'Unlimited referral posts this month'
                : `${usage.used ?? 0} / ${usage.limit} referral posts used this month`}
            {!unlimited && usage.resetsAt && (
                <span style={{ color: '#71717a', fontWeight: 400 }}> · resets {fmtDate(usage.resetsAt)}</span>
            )}
        </div>
    )
}

function StatusPill({ status }) {
    const map = { open: '#22d3ee', accepted: '#4ade80', cancelled: '#71717a', expired: '#fbbf24' }
    const c = map[status] || '#a1a1aa'
    return (
        <span style={{
            color: c, background: c + '1a', border: `1px solid ${c}40`,
            padding: '2px 8px', borderRadius: 6, fontSize: '0.65rem', fontWeight: 900,
            textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap',
        }}>
            {status}
        </span>
    )
}

const cardStyle = {
    background: '#18181b', border: '1px solid #27272a', borderRadius: 10,
    padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8,
}

const btnStyle = {
    padding: '7px 14px', background: 'none', border: '1px solid #27272a',
    borderRadius: 6, color: '#22d3ee', cursor: 'pointer', fontSize: '0.76rem', fontWeight: 700,
}

// ── Tab: Post a request ────────────────────────────────────────────
function PostTab({ limits, onPosted }) {
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
            setResumeFile(null)
            if (fileRef.current) fileRef.current.value = ''
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
                <label className="field-label">Target company</label>
                <CompanyAutocomplete value={company} onChange={setCompany} />
                <p className="field-hint">Pick from the list or type a new company — it&apos;s submitted as-is.</p>
            </div>

            <div className="form-group">
                <label className="field-label">Job ID <span style={{ color: '#52525b', fontWeight: 400 }}>(optional)</span></label>
                <input
                    className="input-field"
                    placeholder="e.g. R-123456"
                    value={jobId}
                    onChange={(e) => setJobId(e.target.value)}
                />
            </div>

            <div className="form-group">
                <label className="field-label">Job title <span style={{ color: '#52525b', fontWeight: 400 }}>(optional)</span></label>
                <input
                    className="input-field"
                    placeholder="e.g. Senior Backend Engineer"
                    value={jobTitle}
                    onChange={(e) => setJobTitle(e.target.value)}
                />
            </div>

            <div className="form-group">
                <label className="field-label">Resume PDF</label>
                <div
                    onClick={() => fileRef.current?.click()}
                    style={{
                        border: `2px dashed ${resumeFile ? '#22d3ee' : '#27272a'}`,
                        borderRadius: 8, padding: '20px 16px', textAlign: 'center',
                        cursor: 'pointer', transition: 'border-color 0.2s',
                        background: resumeFile ? 'rgba(34,211,238,0.04)' : 'transparent',
                    }}
                    onMouseEnter={(e) => { if (!resumeFile) e.currentTarget.style.borderColor = '#3f3f46' }}
                    onMouseLeave={(e) => { if (!resumeFile) e.currentTarget.style.borderColor = '#27272a' }}
                >
                    {resumeFile ? (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                            <span style={{ color: '#22d3ee', fontSize: '0.85rem', fontWeight: 700, overflowWrap: 'anywhere' }}>{resumeFile.name}</span>
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setResumeFile(null); if (fileRef.current) fileRef.current.value = '' }}
                                style={{ background: 'none', border: 'none', color: '#52525b', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}
                            >×</button>
                        </div>
                    ) : (
                        <>
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#52525b" strokeWidth="1.5" style={{ marginBottom: 8 }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                            <p style={{ color: '#71717a', fontSize: '0.85rem', margin: 0 }}>Click to upload your resume PDF</p>
                            <p style={{ color: '#52525b', fontSize: '0.72rem', margin: '4px 0 0' }}>PDF only · max 10MB</p>
                        </>
                    )}
                </div>
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
                <div style={{
                    padding: '10px 12px', background: 'rgba(250,204,21,0.08)',
                    border: '1px solid rgba(250,204,21,0.35)', borderRadius: 6,
                    fontSize: '0.78rem', color: '#facc15',
                }}>
                    You already have an open referral request. Cancel it from “My requests” before posting another.
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
            if (err instanceof ApiError && err.status === 403) setViewErr('Access to this resume is restricted.')
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
            } else if (err instanceof ApiError && err.code === 'no_company') {
                setAcceptErr('Add your current company in your profile before accepting.')
            } else {
                setAcceptErr(errorText(err))
            }
        }
    }

    if (accepted) {
        return (
            <div style={{ ...cardStyle, borderColor: 'rgba(74,222,128,0.3)', background: 'rgba(74,222,128,0.06)' }}>
                <span style={{ fontSize: '0.82rem', color: '#4ade80', fontWeight: 700 }}>
                    You accepted this — the candidate has been emailed your contact info.
                </span>
            </div>
        )
    }

    const cand = r.poster || {}
    const candLine = cand.position
        ? `Candidate: ${cand.position}${cand.years_of_experience ? ` · ${cand.years_of_experience} yrs` : ''}`
        : null

    return (
        <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 900, fontSize: '0.9rem', color: '#fafafa' }}>
                    {r.job_title || 'Referral request'}
                </span>
                <span style={{ fontSize: '0.7rem', color: '#71717a' }}>{r.target_company}</span>
            </div>
            {r.job_id && (
                <span style={{ fontSize: '0.72rem', color: '#71717a' }}>Job ID: {r.job_id}</span>
            )}
            {candLine && (
                <span style={{ fontSize: '0.74rem', color: '#a1a1aa' }}>{candLine}</span>
            )}
            <span style={{ fontSize: '0.68rem', color: '#52525b' }}>
                Posted {relTime(r.created_at)} · expires {relTime(r.expires_at)}
            </span>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                <button type="button" onClick={viewResume} disabled={viewing} style={btnStyle}>
                    {viewing ? 'Opening…' : 'View resume'}
                    {viewing && <span className="spinner" style={{ marginLeft: 6, verticalAlign: 'middle' }} />}
                </button>
                {!gone && (
                    <button
                        type="button"
                        onClick={doAccept}
                        disabled={accept.isPending}
                        style={{ ...btnStyle, color: '#4ade80', borderColor: 'rgba(74,222,128,0.4)' }}
                    >
                        {accept.isPending ? 'Accepting…' : 'Accept & refer'}
                    </button>
                )}
            </div>

            {viewErr && <span style={{ fontSize: '0.72rem', color: '#f87171' }}>{viewErr}</span>}
            {acceptErr && <span style={{ fontSize: '0.72rem', color: '#f87171' }}>{acceptErr}</span>}
        </div>
    )
}

function OpenTab() {
    const { data, isLoading, error, refetch } = useOpenReferrals()

    if (isLoading) return <LoadingState />
    if (error) return <ErrorState err={error} onRetry={refetch} />

    if (data?.no_company) {
        return (
            <EmptyState
                icon="🏢"
                title="Add your company to see referral requests"
                message="Set your current company in your profile — you'll then see requests from candidates targeting it."
                action={<Link to="/profile" className="link-btn">Edit profile</Link>}
            />
        )
    }

    const requests = data?.requests || []
    if (requests.length === 0) {
        const company = requests[0]?.target_company || data?.company
        return (
            <EmptyState
                icon="📭"
                title={`No open referral requests${company ? ` for ${company}` : ''} right now`}
            />
        )
    }

    return (
        <div style={{ display: 'grid', gap: 12 }}>
            {requests.map((r) => <OpenCard key={r.id} r={r} />)}
        </div>
    )
}

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
            if (err instanceof ApiError && err.code === 'not_open_or_not_owner') {
                setCancelErr('This request can no longer be cancelled.')
            } else {
                setCancelErr(errorText(err))
            }
        }
    }

    return (
        <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 900, fontSize: '0.9rem', color: '#fafafa' }}>{r.target_company}</span>
                {r.job_title && <span style={{ fontSize: '0.74rem', color: '#a1a1aa' }}>{r.job_title}</span>}
                <span style={{ marginLeft: 'auto' }}><StatusPill status={r.status} /></span>
            </div>
            {r.job_id && <span style={{ fontSize: '0.72rem', color: '#71717a' }}>Job ID: {r.job_id}</span>}
            <span style={{ fontSize: '0.68rem', color: '#52525b' }}>
                Posted {relTime(r.created_at)} · expires {relTime(r.expires_at)}
            </span>

            {r.status === 'accepted' && r.accepter && (
                <div style={{
                    background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.3)',
                    borderRadius: 8, padding: '10px 12px', fontSize: '0.8rem', color: '#a1a1aa',
                }}>
                    <strong style={{ color: '#fafafa' }}>{r.accepter.name}</strong> accepted — reach out:{' '}
                    <a href={`mailto:${r.accepter.email}`} style={{ color: '#22d3ee' }}>{r.accepter.email}</a>
                </div>
            )}

            {r.status === 'open' && (
                confirming ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <span style={{ fontSize: '0.74rem', color: '#a1a1aa' }}>
                            Cancel this request? Cancelling does not refund this month&apos;s quota.
                        </span>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <button
                                type="button"
                                onClick={doCancel}
                                disabled={cancel.isPending}
                                style={{ ...btnStyle, color: '#f87171', borderColor: 'rgba(248,113,113,0.4)' }}
                            >
                                {cancel.isPending ? 'Cancelling…' : 'Yes, cancel'}
                            </button>
                            <button type="button" onClick={() => setConfirming(false)} style={btnStyle}>Keep it</button>
                        </div>
                    </div>
                ) : (
                    <div>
                        <button type="button" onClick={() => setConfirming(true)} style={btnStyle}>Cancel request</button>
                    </div>
                )
            )}

            {cancelErr && <span style={{ fontSize: '0.72rem', color: '#f87171' }}>{cancelErr}</span>}
        </div>
    )
}

function MineTab() {
    const { data, isLoading, error, refetch } = useMyReferrals()

    if (isLoading) return <LoadingState />
    if (error) return <ErrorState err={error} onRetry={refetch} />

    const requests = data?.requests || []

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <QuotaLine usage={data?.usage} />
            {requests.length === 0 ? (
                <EmptyState icon="📄" title="You haven't posted any referral requests yet" />
            ) : (
                <div style={{ display: 'grid', gap: 12 }}>
                    {requests.map((r) => <MineCard key={r.id} r={r} />)}
                </div>
            )}
        </div>
    )
}

// ── Page ───────────────────────────────────────────────────────────
const TABS = [
    ['open', 'Open for my company'],
    ['post', 'Post a request'],
    ['mine', 'My requests'],
]

export default function ReferralsPage() {
    const { limits, isLoading: entLoading } = useEntitlements()
    const [tab, setTab] = useState('open')
    const [notice, setNotice] = useState('')

    useEffect(() => {
        if (!notice) return
        const t = setTimeout(() => setNotice(''), 8000)
        return () => clearTimeout(t)
    }, [notice])

    const onPosted = () => {
        setNotice('Request posted — matching employees have been notified.')
        setTab('mine')
    }

    return (
        <>
            <Navbar />
            <main className="wrap" style={{ maxWidth: 980, margin: '0 auto', padding: '72px 16px 48px' }}>
                <header style={{ marginBottom: 18 }}>
                    <h1 style={{ fontSize: '1.4rem', fontWeight: 900, color: '#fafafa', letterSpacing: '-0.03em' }}>Referrals</h1>
                    <p style={{ color: '#71717a', fontSize: '0.85rem', marginTop: 6 }}>
                        Ask verified employees to refer you — or refer candidates targeting your company.
                    </p>
                </header>

                {notice && (
                    <p style={{
                        marginBottom: 16, fontSize: '0.8rem', color: '#4ade80',
                        background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.25)',
                        borderRadius: 8, padding: '10px 14px',
                    }}>
                        {notice}
                    </p>
                )}

                <div
                    className="profile-segment"
                    role="tablist"
                    aria-label="Referral views"
                    style={{ maxWidth: 460, flexWrap: 'wrap', marginBottom: 18 }}
                >
                    {TABS.map(([id, label]) => (
                        <button
                            key={id}
                            type="button"
                            role="tab"
                            aria-selected={tab === id}
                            className={'profile-segment-btn' + (tab === id ? ' is-active' : '')}
                            onClick={() => setTab(id)}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                {tab === 'post' && (entLoading ? <LoadingState /> : <PostTab limits={limits} onPosted={onPosted} />)}
                {tab === 'open' && <OpenTab />}
                {tab === 'mine' && <MineTab />}
            </main>
        </>
    )
}

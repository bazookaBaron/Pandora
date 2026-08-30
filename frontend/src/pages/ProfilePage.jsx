import { useEffect, useRef, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { apiFetch } from '../lib/apiClient'
import { useAuth } from '../contexts/AuthContext'
import { useMediaQuery } from '../lib/useMediaQuery'
import { useEntitlements } from '../lib/useEntitlements'
import { useCompanyOptions } from '../lib/useReferrals'
import Navbar from '../components/Navbar'

// ── Helpers ──────────────────────────────────────────────────────────

function getInitials(user) {
    const name =
        user?.user_metadata?.full_name ||
        user?.user_metadata?.name ||
        user?.email?.split('@')[0] || 'U'
    const parts = name.split(' ').filter(Boolean)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return name.slice(0, 2).toUpperCase()
}

function stringToColor(str = '') {
    let hash = 0
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash)
    const colors = ['#22d3ee', '#f472b6', '#4ade80', '#facc15', '#a78bfa', '#fb923c', '#60a5fa']
    return colors[Math.abs(hash) % colors.length]
}

function PwStrengthBar({ password }) {
    let score = 0
    if (password.length >= 8) score++
    if (/[A-Z]/.test(password)) score++
    if (/[0-9]/.test(password)) score++
    if (/[^A-Za-z0-9]/.test(password)) score++
    const levels = [
        { pct: '0%', color: 'transparent', text: '' },
        { pct: '25%', color: '#f87171', text: 'Weak' },
        { pct: '50%', color: '#fb923c', text: 'Fair' },
        { pct: '75%', color: '#facc15', text: 'Good' },
        { pct: '100%', color: '#4ade80', text: 'Strong' },
    ]
    const level = levels[score]
    if (!password) return null
    return (
        <div style={{ marginTop: 6 }}>
            <div className="pw-strength">
                <div className="pw-strength-bar" style={{ width: level.pct, background: level.color }} />
            </div>
            {level.text && <p className="field-hint" style={{ marginTop: 4 }}>{level.text}</p>}
        </div>
    )
}

// ── Dashboard sub-components ─────────────────────────────────────────

function RingProgress({ pct, color, size = 72, stroke = 7 }) {
    const r = (size - stroke) / 2
    const circ = 2 * Math.PI * r
    const dash = circ * Math.min(1, pct / 100)
    return (
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color + '22'} strokeWidth={stroke} />
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
                strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
                style={{ transition: 'stroke-dasharray 0.8s cubic-bezier(.4,0,.2,1)' }} />
        </svg>
    )
}

function StatCard({ label, value, color, link }) {
    return (
        <div style={{ background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '14px 18px' }}>
            <div style={{ fontSize: '1.6rem', fontWeight: 900, color }}>{value}</div>
            <div style={{ fontSize: '0.65rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginTop: 4 }}>{label}</div>
            {link && <Link to={link} style={{ fontSize: '0.65rem', color, textDecoration: 'none', marginTop: 6, display: 'block', opacity: 0.7 }}>View →</Link>}
        </div>
    )
}

function ProgressSection({ user }) {
    const isMobile = useMediaQuery('(max-width: 767px)')
    const isTablet = useMediaQuery('(max-width: 1023px)')

    const statCols = isMobile ? 'repeat(auto-fill, minmax(120px, 1fr))' : 'repeat(auto-fill, minmax(130px, 1fr))'
    const ringCols = isMobile ? '1fr' : isTablet ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)'
    const pairCols = isMobile ? '1fr' : '1fr 1fr'
    const companyCols = isMobile ? '1fr' : isTablet ? 'repeat(2, 1fr)' : 'repeat(auto-fill, minmax(200px, 1fr))'

    const { data: progressRows = [] } = useQuery({
        queryKey: ['all-progress', user?.id],
        queryFn: async () => {
            if (!user) return []
            const { data } = await supabase
                .from('user_problem_progress')
                .select('problem_type, status, is_bookmarked, updated_at, problem_id')
                .eq('user_id', user.id)
                .order('updated_at', { ascending: false })
            return data || []
        },
        enabled: !!user, staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: true,
    })

    // All catalog-derived aggregates come pre-computed from the server (service
    // role) — no per-row catalog data is fetched in the browser.
    const { data: overview, isLoading: overviewLoading } = useQuery({
        queryKey: ['stats-overview', user?.id],
        queryFn: () => apiFetch('/api/stats/overview'),
        enabled: !!user,
        staleTime: 5 * 60 * 1000,
        refetchOnMount: 'always',
    })
    const totals = overview?.totals || { dsa: 0, lld: 0, hld: 0 }
    const readiness = overview?.readiness || []
    const readinessLoading = overviewLoading

    // Computed
    const dsaSolved = progressRows.filter(r => r.problem_type === 'dsa' && r.status === 'solved').length
    const lldSolved = progressRows.filter(r => r.problem_type === 'lld' && r.status === 'solved').length
    const hldAttempted = progressRows.filter(r => r.problem_type === 'hld' && ['attempted', 'solved'].includes(r.status)).length
    const dsaPct = totals.dsa ? Math.round((dsaSolved / totals.dsa) * 100) : 0
    const lldPct = totals.lld ? Math.round((lldSolved / totals.lld) * 100) : 0
    const hldPct = totals.hld ? Math.round((hldAttempted / totals.hld) * 100) : 0

    const diffColors = { Easy: '#4ade80', Medium: '#facc15', Hard: '#f87171' }
    const diffBreakdown = overview?.difficulty || []

    const recentActivity = progressRows.filter(r => r.status !== 'unsolved').slice(0, 5)

    const companyMap = {}
    readiness.forEach(r => {
        if (!companyMap[r.company_name]) companyMap[r.company_name] = { dsa: null, lld: null }
        companyMap[r.company_name][r.problem_type] = r
    })
    const focusCompanies = Object.entries(companyMap)
        .filter(([, d]) => (d.dsa?.solved ?? 0) + (d.lld?.solved ?? 0) > 0)
        .sort(([, a], [, b]) => ((b.dsa?.solved ?? 0) + (b.lld?.solved ?? 0)) - ((a.dsa?.solved ?? 0) + (a.lld?.solved ?? 0)))
        .slice(0, 12)

    const weakTopics = (overview?.topics || [])
        .filter(s => s.total >= 5 && s.solved > 0)
        .sort((a, b) => (a.solved / a.total) - (b.solved / b.total))
        .slice(0, 5)
        .map(s => [s.topic, { total: s.total, solved: s.solved }])

    const modules = [
        { label: 'DSA', pct: dsaPct, color: '#22d3ee', solved: dsaSolved, total: totals.dsa, link: '/dsa' },
        { label: 'LLD', pct: lldPct, color: '#f472b6', solved: lldSolved, total: totals.lld, link: '/lld' },
        { label: 'HLD', pct: hldPct, color: '#a78bfa', solved: hldAttempted, total: totals.hld, link: '/hld' },
    ]

    return (
        <section className="card profile-card">
            <h2 className="profile-section-title">Progress Overview</h2>

            {/* Stat cards */}
            <div style={{ display: 'grid', gridTemplateColumns: statCols, gap: 10, marginBottom: 16 }}>
                <StatCard label="DSA Solved" value={dsaSolved} color="#22d3ee" link="/dsa?status=solved" />
                <StatCard label="LLD Practiced" value={lldSolved} color="#f472b6" link="/lld" />
                <StatCard label="HLD Attempted" value={hldAttempted} color="#a78bfa" link="/hld" />
                <StatCard label="Companies" value={focusCompanies.length} color="#fb923c" />
            </div>

            {/* Progress rings */}
            <div style={{ display: 'grid', gridTemplateColumns: ringCols, gap: 10, marginBottom: 16 }}>
                {modules.map(m => (
                    <div key={m.label} style={{ background: 'var(--surface-2)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '16px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                        <div style={{ position: 'relative' }}>
                            <RingProgress pct={m.pct} color={m.color} />
                            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <span style={{ fontSize: '0.9rem', fontWeight: 900, color: m.color }}>{m.pct}%</span>
                            </div>
                        </div>
                        <div style={{ textAlign: 'center' }}>
                            <div style={{ fontWeight: 900, fontSize: '0.78rem', color: 'var(--bright)' }}>{m.label}</div>
                            <div style={{ fontSize: '0.65rem', color: 'var(--muted)', marginTop: 2 }}>{m.solved} / {m.total}</div>
                        </div>
                        <Link to={m.link} style={{ fontSize: '0.65rem', color: m.color, textDecoration: 'none', opacity: 0.8 }}>Open →</Link>
                    </div>
                ))}
            </div>

            {/* Difficulty + Recent Activity side by side */}
            <div style={{ display: 'grid', gridTemplateColumns: pairCols, gap: 16, marginBottom: 16 }}>
                <div style={{ background: 'var(--surface-2)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '16px 18px' }}>
                    <h3 style={{ fontSize: '0.72rem', fontWeight: 900, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>DSA Difficulty</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {diffBreakdown.map(({ d, total, done }) => {
                            const pct = total ? Math.round((done / total) * 100) : 0
                            return (
                                <div key={d}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                        <span style={{ fontSize: '0.7rem', fontWeight: 700, color: diffColors[d] }}>{d}</span>
                                        <span style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>{done}/{total}</span>
                                    </div>
                                    <div style={{ height: 5, background: 'var(--subtle)', borderRadius: 3, overflow: 'hidden' }}>
                                        <div style={{ width: `${pct}%`, height: '100%', background: diffColors[d], borderRadius: 3, transition: 'width 0.6s ease' }} />
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                </div>

                <div style={{ background: 'var(--surface-2)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '16px 18px' }}>
                    <h3 style={{ fontSize: '0.72rem', fontWeight: 900, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Recent Activity</h3>
                    {recentActivity.length === 0 ? (
                        <p style={{ color: 'var(--faint)', fontSize: '0.78rem' }}>No activity yet.</p>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                            {recentActivity.map((r, i) => {
                                const typeColor = r.problem_type === 'dsa' ? '#22d3ee' : r.problem_type === 'lld' ? '#f472b6' : '#a78bfa'
                                const ago = Math.round((Date.now() - new Date(r.updated_at).getTime()) / 60000)
                                const agoStr = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`
                                return (
                                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <span style={{ fontSize: '0.58rem', fontWeight: 900, textTransform: 'uppercase', color: typeColor, background: typeColor + '18', border: `1px solid ${typeColor}33`, borderRadius: 4, padding: '1px 5px', flexShrink: 0 }}>{r.problem_type}</span>
                                        <span style={{ fontSize: '0.7rem', color: r.status === 'solved' ? '#4ade80' : '#facc15', fontWeight: 700, textTransform: 'uppercase', flexShrink: 0 }}>{r.status}</span>
                                        <span style={{ fontSize: '0.65rem', color: 'var(--faint)', marginLeft: 'auto', flexShrink: 0 }}>{agoStr}</span>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* Weak Topics */}
            {weakTopics.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                    <h3 style={{ fontSize: '0.72rem', fontWeight: 900, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                        ⚠️ Weak Topics <span style={{ color: 'var(--faint)', fontWeight: 400, textTransform: 'none' }}>(low solve rate)</span>
                    </h3>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                        {weakTopics.map(([topic, s]) => (
                            <Link key={topic} to={`/dsa?q=${encodeURIComponent(topic)}`} style={{ textDecoration: 'none' }}>
                                <div style={{ background: 'var(--subtle)', border: '1px solid var(--subtle-strong)', borderRadius: 6, padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 7 }}>
                                    <span style={{ fontSize: '0.72rem', color: 'var(--bright)', fontWeight: 700 }}>{topic}</span>
                                    <span style={{ fontSize: '0.62rem', color: '#f87171', fontWeight: 900 }}>{Math.round((s.solved / s.total) * 100)}%</span>
                                </div>
                            </Link>
                        ))}
                    </div>
                </div>
            )}

        </section>
    )
}

// ── Feedback: request a feature / report a bug ──────────────────────

function FeedbackSection() {
    const [kind, setKind] = useState('feature')
    const [message, setMessage] = useState('')
    const [status, setStatus] = useState({ type: '', msg: '' })
    const [sending, setSending] = useState(false)

    const submit = async (e) => {
        e.preventDefault()
        const body = message.trim()
        if (body.length < 10) {
            setStatus({ type: 'error', msg: 'Please add a little more detail (min. 10 characters).' })
            return
        }
        setSending(true)
        setStatus({ type: '', msg: '' })
        try {
            await apiFetch('/api/feedback', { json: { kind, message: body } })
            setStatus({ type: 'success', msg: 'Thanks — your message was sent.' })
            setMessage('')
        } catch (err) {
            setStatus({ type: 'error', msg: err?.body?.error || err?.message || 'Could not send. Try again.' })
        } finally {
            setSending(false)
        }
    }

    return (
        <section className="card profile-card">
            <h2 className="profile-section-title">Feedback</h2>
            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                    <label className="field-label">Type</label>
                    <select className="input-field" value={kind} onChange={(e) => setKind(e.target.value)} style={{ maxWidth: 240 }}>
                        <option value="feature">Request a feature</option>
                        <option value="bug">Report a bug</option>
                    </select>
                </div>
                <div>
                    <label className="field-label">Message</label>
                    <textarea
                        className="input-field"
                        rows={4}
                        maxLength={4000}
                        placeholder={kind === 'bug'
                            ? 'What went wrong, and what were you doing when it happened?'
                            : 'What would you like Vloombox to do?'}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        style={{ resize: 'vertical', minHeight: 90 }}
                    />
                </div>
                <button type="submit" className="primary-btn" disabled={sending} style={{ width: 'auto', padding: '10px 24px' }}>
                    <span>{sending ? 'Sending…' : 'Send'}</span>
                    {sending && <div className="spinner" />}
                </button>
                {status.msg && (
                    <div className={`auth-status auth-status--${status.type}`}>{status.msg}</div>
                )}
            </form>
        </section>
    )
}

// ── Referral profile ────────────────────────────────────────────────

function CompanyAutocomplete({ value, onChange, placeholder = 'Start typing a company…' }) {
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
                    background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 6,
                    maxHeight: 200, overflowY: 'auto', zIndex: 50,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                }}>
                    {options.map((c) => (
                        <div
                            key={c}
                            onMouseDown={(e) => { e.preventDefault(); onChange(c); setOpen(false) }}
                            style={{
                                padding: '7px 12px', cursor: 'pointer', fontSize: '0.82rem',
                                color: 'var(--accent)', borderBottom: '1px solid rgba(39,39,42,0.5)',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--subtle)'; e.currentTarget.style.color = 'var(--bright)' }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--accent)' }}
                        >
                            {c}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

function ReferralProfileCard({ user }) {
    const { data: profile, isLoading } = useQuery({
        queryKey: ['referral-profile', user?.id],
        queryFn: async () => {
            const { data, error } = await supabase
                .from('profiles')
                .select('company, position, years_of_experience, receive_referral_notifications')
                .eq('id', user.id)
                .maybeSingle()
            if (error) throw error
            return data || {}
        },
        enabled: !!user,
        staleTime: 60_000,
    })

    const [company, setCompany] = useState('')
    const [position, setPosition] = useState('')
    const [yoe, setYoe] = useState('')
    const [notify, setNotify] = useState(true)
    const [hydrated, setHydrated] = useState(false)
    const [saving, setSaving] = useState(false)
    const [status, setStatus] = useState({ msg: '', type: '' })

    useEffect(() => {
        if (!profile || hydrated) return
        setCompany(profile.company || '')
        setPosition(profile.position || '')
        setYoe(profile.years_of_experience == null ? '' : String(profile.years_of_experience))
        setNotify(profile.receive_referral_notifications ?? true)
        setHydrated(true)
    }, [profile, hydrated])

    const save = async (e) => {
        e.preventDefault()
        setSaving(true)
        setStatus({ msg: '', type: '' })
        const { error } = await supabase.from('profiles').upsert({
            id: user.id,
            company: company.trim() || null,
            position: position.trim() || null,
            years_of_experience: yoe === '' ? null : Number(yoe),
            receive_referral_notifications: notify,
        }, { onConflict: 'id' })
        setSaving(false)
        setStatus(error
            ? { msg: error.message || 'Could not save — try again.', type: 'error' }
            : { msg: 'Referral profile saved.', type: 'ok' })
    }

    return (
        <section className="card profile-card">
            <h2 className="profile-section-title">Referral profile</h2>
            {isLoading ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ height: 38, background: 'var(--subtle)', borderRadius: 6, animation: 'pulse 1.5s ease-in-out infinite' }} />
                    <div style={{ height: 38, background: 'var(--subtle)', borderRadius: 6, animation: 'pulse 1.5s ease-in-out infinite' }} />
                    <div style={{ height: 38, width: '50%', background: 'var(--subtle)', borderRadius: 6, animation: 'pulse 1.5s ease-in-out infinite' }} />
                </div>
            ) : (
                <form onSubmit={save}>
                    <div className="form-group">
                        <label className="field-label">Current company</label>
                        <CompanyAutocomplete value={company} onChange={setCompany} />
                    </div>
                    <div className="form-group">
                        <label className="field-label">Position / title</label>
                        <input
                            type="text" className="input-field" placeholder="e.g. Senior Software Engineer"
                            value={position} onChange={e => setPosition(e.target.value)}
                        />
                    </div>
                    <div className="form-group">
                        <label className="field-label">Years of experience</label>
                        <input
                            type="number" min={0} step={0.5} className="input-field" placeholder="e.g. 4"
                            value={yoe} onChange={e => setYoe(e.target.value)}
                        />
                    </div>
                    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', margin: '4px 0 16px' }}>
                        <input
                            type="checkbox"
                            checked={notify}
                            onChange={e => setNotify(e.target.checked)}
                            style={{ marginTop: 2, accentColor: '#22d3ee' }}
                        />
                        <span style={{ fontSize: '0.82rem', color: 'var(--accent)', lineHeight: 1.5 }}>
                            Email me when someone posts a referral request for my company
                        </span>
                    </label>
                    <button
                        type="submit"
                        className="primary-btn"
                        disabled={saving}
                        style={{ width: 'auto', padding: '10px 24px' }}
                    >
                        <span>{saving ? 'Saving…' : 'Save'}</span>
                        {saving && <div className="spinner" />}
                    </button>
                    {status.msg && (
                        <div className={`auth-status auth-status--${status.type}`} style={{ marginTop: 12 }}>
                            {status.msg}
                        </div>
                    )}
                </form>
            )}
        </section>
    )
}

// ── Main page ────────────────────────────────────────────────────────

export default function ProfilePage() {
    const { user, logout } = useAuth()
    const navigate = useNavigate()
    const { plan, isLoading: planLoading } = useEntitlements()

    const [newPw, setNewPw] = useState('')
    const [showNewPw, setShowNewPw] = useState(false)
    const [pwLoading, setPwLoading] = useState(false)
    const [pwStatus, setPwStatus] = useState({ msg: '', type: '' })

    const [editNameOpen, setEditNameOpen] = useState(false)
    const [editName, setEditName] = useState(user?.user_metadata?.full_name || '')
    const [nameLoading, setNameLoading] = useState(false)
    const [nameStatus, setNameStatus] = useState({ msg: '', type: '' })

    const displayName =
        user?.user_metadata?.full_name ||
        user?.user_metadata?.name ||
        user?.email?.split('@')[0] || 'User'

    const joined = user?.created_at
        ? new Date(user.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        : '—'

    const provider = user?.app_metadata?.provider || 'email'
    const isOAuth = provider !== 'email'

    const handleChangePassword = async (e) => {
        e.preventDefault()
        if (newPw.length < 8) { setPwStatus({ msg: 'Password must be at least 8 characters.', type: 'error' }); return }
        setPwLoading(true)
        const { error } = await supabase.auth.updateUser({ password: newPw })
        setPwLoading(false)
        if (error) {
            setPwStatus({ msg: error.message, type: 'error' })
        } else {
            setPwStatus({ msg: 'Password updated successfully!', type: 'ok' })
            setNewPw('')
        }
    }

    const handleUpdateName = async (e) => {
        e.preventDefault()
        setNameLoading(true)
        const { error } = await supabase.auth.updateUser({ data: { full_name: editName } })
        setNameLoading(false)
        if (error) {
            setNameStatus({ msg: error.message, type: 'error' })
        } else {
            setEditNameOpen(false)
            setNameStatus({ msg: '', type: '' })
            window.location.reload()
        }
    }

    const handleLogout = async () => {
        await logout()
        navigate('/auth')
    }

    const planLabel = plan === 'pro' ? 'Pro Plan' : plan === 'max' ? 'Max Plan' : 'Free Plan'
    const planBadgeStyle =
        plan === 'max'
            ? {
                background: 'linear-gradient(135deg, rgba(167,139,250,0.18), rgba(34,211,238,0.18))',
                color: '#a78bfa',
                borderColor: 'rgba(167, 139, 250, 0.35)',
            }
            : plan === 'pro'
                ? undefined // default .profile-badge (cyan / --pop)
                : {
                    background: 'rgba(113, 113, 122, 0.12)',
                    color: 'var(--muted)',
                    borderColor: 'rgba(113, 113, 122, 0.25)',
                }

    return (
        <>
            <Navbar />
            <main className="wrap profile-wrap">
                {/* Hero */}
                <div className="profile-hero">
                    <div
                        className="profile-avatar"
                        style={{ background: stringToColor(user?.email) }}
                    >
                        {getInitials(user)}
                    </div>
                    <div className="profile-hero-info">
                        <h1 className="profile-name">{displayName}</h1>
                        <p className="profile-email">{user?.email}</p>
                        <Link
                            to="/pricing"
                            className="profile-badge"
                            style={{ textDecoration: 'none', ...(planBadgeStyle || {}) }}
                        >
                            {planLabel}
                        </Link>
                    </div>
                </div>

                {/* Account Details */}
                <section className="card profile-card">
                    <h2 className="profile-section-title">Account Details</h2>

                    <div className="profile-field">
                        <span className="profile-field-label">Full Name</span>
                        <div className="profile-field-value-row">
                            <span className="profile-field-value">{displayName}</span>
                            <button className="link-btn" onClick={() => setEditNameOpen(true)}>Edit</button>
                        </div>
                    </div>
                    <div className="profile-divider" />
                    <div className="profile-field">
                        <span className="profile-field-label">Email Address</span>
                        <span className="profile-field-value">{user?.email || '—'}</span>
                    </div>
                    <div className="profile-divider" />
                    <div className="profile-field">
                        <span className="profile-field-label">Member Since</span>
                        <span className="profile-field-value">{joined}</span>
                    </div>
                    <div className="profile-divider" />
                    <div className="profile-field">
                        <span className="profile-field-label">Auth Provider</span>
                        <span className="profile-field-value" style={{ textTransform: 'capitalize' }}>{provider}</span>
                    </div>
                </section>

                {/* Subscription */}
                <section className="card profile-card">
                    <h2 className="profile-section-title">Subscription</h2>
                    {planLoading ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <div style={{ height: 16, width: '40%', background: 'var(--subtle)', borderRadius: 4, animation: 'pulse 1.5s ease-in-out infinite' }} />
                            <div style={{ height: 14, width: '25%', background: 'var(--subtle)', borderRadius: 4, animation: 'pulse 1.5s ease-in-out infinite' }} />
                        </div>
                    ) : (
                        <>
                            <div className="profile-field">
                                <span className="profile-field-label">Plan</span>
                                <span className="profile-field-value">{planLabel}</span>
                            </div>
                            <div className="profile-divider" />
                            <div className="profile-field">
                                <span className="profile-field-label">Status</span>
                                <span className="profile-field-value">{plan === 'free' ? 'No active subscription' : 'Active'}</span>
                            </div>
                            <div className="profile-divider" />
                            <div className="profile-field">
                                <span className="profile-field-label">Billing</span>
                                <div className="profile-field-value-row">
                                    <Link to="/pricing" className="link-btn">{plan === 'free' ? 'Upgrade' : 'Manage / Upgrade'}</Link>
                                </div>
                            </div>
                        </>
                    )}
                </section>

                {/* Referral profile */}
                <ReferralProfileCard user={user} />

                {/* Security — only for email/password accounts */}
                {!isOAuth && (
                    <section className="card profile-card">
                        <h2 className="profile-section-title">Security</h2>
                        <form onSubmit={handleChangePassword}>
                            <div className="form-group">
                                <label className="field-label">New Password</label>
                                <div className="pw-row">
                                    <input
                                        type={showNewPw ? 'text' : 'password'}
                                        className="input-field"
                                        placeholder="Min. 8 characters"
                                        minLength={8}
                                        value={newPw}
                                        onChange={e => setNewPw(e.target.value)}
                                    />
                                    <button type="button" className="icon-btn" onClick={() => setShowNewPw(v => !v)}>
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                                        </svg>
                                    </button>
                                </div>
                                <PwStrengthBar password={newPw} />
                            </div>
                            <button
                                type="submit"
                                className="primary-btn"
                                disabled={pwLoading}
                                style={{ width: 'auto', padding: '10px 24px' }}
                            >
                                <span>{pwLoading ? 'Updating…' : 'Update Password'}</span>
                                {pwLoading && <div className="spinner" />}
                            </button>
                            {pwStatus.msg && (
                                <div className={`auth-status auth-status--${pwStatus.type}`} style={{ marginTop: 12 }}>
                                    {pwStatus.msg}
                                </div>
                            )}
                        </form>
                    </section>
                )}

                {/* Progress Overview */}
                <ProgressSection user={user} />

                {/* Feedback */}
                <FeedbackSection />

                {/* Session */}
                <section className="card profile-card">
                    <h2 className="profile-section-title">Session</h2>
                    <button className="profile-signout-btn" onClick={handleLogout}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                        </svg>
                        Sign Out
                    </button>
                </section>
            </main>

            {/* Edit Name Modal */}
            {editNameOpen && (
                <div
                    className="modal-overlay"
                    onClick={e => { if (e.target === e.currentTarget) setEditNameOpen(false) }}
                >
                    <div className="modal-card card" style={{ maxWidth: 360, margin: '0 auto' }}>
                        <h3 className="modal-title">Update Display Name</h3>
                        <form onSubmit={handleUpdateName}>
                            <div className="form-group">
                                <label className="field-label">Full Name</label>
                                <input
                                    type="text"
                                    className="input-field"
                                    placeholder="Jane Doe"
                                    value={editName}
                                    onChange={e => setEditName(e.target.value)}
                                    required
                                    autoFocus
                                />
                            </div>
                            {nameStatus.msg && (
                                <div className={`auth-status auth-status--${nameStatus.type}`} style={{ marginBottom: 12 }}>
                                    {nameStatus.msg}
                                </div>
                            )}
                            <div className="modal-actions">
                                <button type="button" className="secondary-btn" onClick={() => setEditNameOpen(false)}>Cancel</button>
                                <button type="submit" className="primary-btn" disabled={nameLoading} style={{ flex: 1, padding: 10 }}>
                                    <span>{nameLoading ? 'Saving…' : 'Save'}</span>
                                    {nameLoading && <div className="spinner" />}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </>
    )
}

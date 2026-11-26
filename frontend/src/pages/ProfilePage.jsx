import { useState } from 'react'
import { Link } from 'react-router-dom'
import { User, Shield, Eye, EyeOff, LogOut } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useEntitlements } from '../lib/useEntitlements'
import { planTone } from '../lib/brand'
import { SectionHead, Button } from '../components/ui'
import Navbar from '../components/Navbar'
import { toast } from '../lib/toast'
import AvatarEditor from './profile/AvatarEditor'
import ProgressSection from './profile/ProgressSection'
import FeedbackSection from './profile/FeedbackSection'
import ReferralProfileCard from './profile/ReferralProfileCard'
import CompanySubscriptionsCard from './profile/CompanySubscriptionsCard'

// Password strength: 0-4 checks -> a semantic tone.
const PW_LEVELS = [
    null,
    { pct: 25, tone: 'danger', text: 'Weak' },
    { pct: 50, tone: 'attention', text: 'Fair' },
    { pct: 75, tone: 'waiting', text: 'Good' },
    { pct: 100, tone: 'success', text: 'Strong' },
]

function PwStrengthBar({ password }) {
    if (!password) return null
    let score = 0
    if (password.length >= 8) score++
    if (/[A-Z]/.test(password)) score++
    if (/[0-9]/.test(password)) score++
    if (/[^A-Za-z0-9]/.test(password)) score++
    const level = PW_LEVELS[score]
    if (!level) return null
    return (
        <div className={`profile-pw tone-${level.tone}`}>
            <div className="sys-progress is-toned is-thin" role="progressbar" aria-label="Password strength"
                aria-valuemin={0} aria-valuemax={4} aria-valuenow={score} aria-valuetext={level.text}>
                <span style={{ width: `${level.pct}%` }} />
            </div>
            <span className="tone-text">{level.text}</span>
        </div>
    )
}

function Row({ label, children }) {
    return (
        <div className="profile-kv">
            <span className="profile-kv-label">{label}</span>
            <span className="profile-kv-value">{children}</span>
        </div>
    )
}

export default function ProfilePage() {
    const { user, logout } = useAuth()
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
        ? new Date(user.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
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
            toast.success('Password updated.')
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
            // supabase fires USER_UPDATED with the new metadata, so AuthContext
            // re-renders the name; no reload needed
            setEditNameOpen(false)
            setNameStatus({ msg: '', type: '' })
            toast.success('Name updated.')
        }
    }

    const [signingOut, setSigningOut] = useState(false)
    const handleLogout = async () => {
        if (signingOut) return
        setSigningOut(true)
        try { await logout() } finally { setSigningOut(false) }
    }

    const planLabel = plan === 'pro' ? 'Pro' : plan === 'max' ? 'Max' : 'Free'

    return (
        <>
            <Navbar />
            <main className="wrap profile-wrap">
                {/* Hero */}
                <div className="profile-hero" data-tour="profile-hero">
                    <AvatarEditor user={user} />
                    <div className="profile-hero-info">
                        <h1 className="profile-name">{displayName}</h1>
                        <p className="profile-email">{user?.email}</p>
                        {!planLoading && (
                            <Link to="/pricing" className={`sys-pill tone-${planTone(plan).tone} profile-plan`}>{planLabel} plan</Link>
                        )}
                    </div>
                </div>

                {/* Account (details + subscription) */}
                <section className="card profile-card" aria-labelledby="pf-account-h">
                    <SectionHead icon={User} title="Account" tone="active" id="pf-account-h" />
                    <div className="profile-kvs">
                        <Row label="Name">
                            <span className="profile-kv-text">{displayName}</span>
                            <button type="button" className="link-btn" onClick={() => setEditNameOpen(true)}>Edit</button>
                        </Row>
                        <Row label="Email"><span className="profile-kv-text">{user?.email || '—'}</span></Row>
                        <Row label="Plan">
                            {planLoading ? <span className="profile-kv-text">…</span> : (
                                <>
                                    <span className="profile-kv-text">{plan === 'free' ? 'Free' : `${planLabel} · active`}</span>
                                    <Link to="/pricing" className="link-btn">{plan === 'free' ? 'Upgrade' : 'Manage'}</Link>
                                </>
                            )}
                        </Row>
                        <Row label="Joined"><span className="profile-kv-text">{joined}</span></Row>
                        <Row label="Sign-in"><span className="profile-kv-text" style={{ textTransform: 'capitalize' }}>{provider}</span></Row>
                    </div>
                </section>

                {/* Progress overview */}
                <ProgressSection user={user} />

                {/* Referral profile */}
                <ReferralProfileCard user={user} />

                {/* Subscribed companies (job alerts) */}
                <CompanySubscriptionsCard />

                {/* Security — only for email/password accounts */}
                {!isOAuth && (
                    <section className="card profile-card" aria-labelledby="pf-security-h">
                        <SectionHead icon={Shield} title="Security" tone="waiting" id="pf-security-h" />
                        <form onSubmit={handleChangePassword} className="profile-form">
                            <div className="sys-field">
                                <label className="sys-field-label" htmlFor="pf-new-pw">New password</label>
                                <div className="pw-row">
                                    <input
                                        id="pf-new-pw"
                                        type={showNewPw ? 'text' : 'password'}
                                        className="input-field"
                                        placeholder="Min. 8 characters"
                                        minLength={8}
                                        autoComplete="new-password"
                                        value={newPw}
                                        onChange={e => setNewPw(e.target.value)}
                                    />
                                    <button type="button" className="icon-btn" onClick={() => setShowNewPw(v => !v)}
                                        aria-label={showNewPw ? 'Hide password' : 'Show password'} aria-pressed={showNewPw}>
                                        {showNewPw ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                                    </button>
                                </div>
                                <PwStrengthBar password={newPw} />
                            </div>
                            <div className="profile-actions">
                                <Button type="submit" variant="primary" busy={pwLoading} busyLabel="Updating…">Update password</Button>
                            </div>
                            {pwStatus.msg && (
                                <p className={`sys-note ${pwStatus.type === 'error' ? 'is-danger' : 'is-ok'}`} role="status">{pwStatus.msg}</p>
                            )}
                        </form>
                    </section>
                )}

                {/* Feedback */}
                <FeedbackSection />

                {/* Session */}
                <div className="profile-signout">
                    <Button icon={LogOut} onClick={handleLogout} busy={signingOut} busyLabel="Signing out…">Sign out</Button>
                </div>
            </main>

            {/* Edit Name Modal */}
            {editNameOpen && (
                <div
                    className="modal-overlay"
                    onClick={e => { if (e.target === e.currentTarget) setEditNameOpen(false) }}
                    onKeyDown={e => { if (e.key === 'Escape') setEditNameOpen(false) }}
                >
                    <div className="modal-card card" role="dialog" aria-modal="true" aria-labelledby="pf-name-h" style={{ maxWidth: 360, margin: '0 auto' }}>
                        <h3 className="modal-title" id="pf-name-h">Display name</h3>
                        <form onSubmit={handleUpdateName} className="profile-form">
                            <label htmlFor="pf-name" className="sys-sr">Full name</label>
                            <input
                                id="pf-name"
                                type="text"
                                className="input-field"
                                placeholder="Jane Doe"
                                value={editName}
                                onChange={e => setEditName(e.target.value)}
                                required
                                autoFocus
                            />
                            {nameStatus.msg && (
                                <p className={`sys-note ${nameStatus.type === 'error' ? 'is-danger' : 'is-ok'}`} role="status">{nameStatus.msg}</p>
                            )}
                            <div className="profile-actions">
                                <Button onClick={() => setEditNameOpen(false)}>Cancel</Button>
                                <Button type="submit" variant="primary" busy={nameLoading} busyLabel="Saving…">Save</Button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </>
    )
}

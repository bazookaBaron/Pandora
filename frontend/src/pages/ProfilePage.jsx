import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell, CreditCard, Eye, EyeOff, LifeBuoy, LogOut, UserRound } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useEntitlements } from '../lib/useEntitlements'
import { planTone } from '../lib/brand'
import { Button, PageHeader, Row, Sheet } from '../components/ui'
import Navbar from '../components/Navbar'
import { PageContainer } from '../components/shared/Layout'
import { toast } from '../lib/toast'
import AvatarEditor from './profile/AvatarEditor'
import ProgressSection from './profile/ProgressSection'
import FeedbackSection from './profile/FeedbackSection'
import ReferralProfileCard from './profile/ReferralProfileCard'
import CompanySubscriptionsCard from './profile/CompanySubscriptionsCard'

// Me (plan §4.6): avatar · name · plan pill, then one row per area. Each row
// opens its existing content in a sheet (Plan & billing goes to /pricing).
// Sign out lives here: the navbar no longer has it.

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

function KV({ label, children }) {
    return (
        <div className="profile-kv">
            <span className="profile-kv-label">{label}</span>
            <span className="profile-kv-value">{children}</span>
        </div>
    )
}

const HELP_LINKS = [
    ['/faq', 'FAQ'],
    ['/contact', 'Contact us'],
    ['/terms', 'Terms'],
    ['/privacy', 'Privacy'],
    ['/refunds', 'Refunds'],
]

export default function ProfilePage() {
    const { user, logout } = useAuth()
    const { plan, isLoading: planLoading } = useEntitlements()
    const [view, setView] = useState(null) // null | 'profile' | 'alerts' | 'help'

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
            setPwStatus({ msg: 'Password updated.', type: 'ok' })
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
    const close = () => setView(null)

    return (
        <>
            <Navbar />
            <PageContainer width="sm" className="me-page">
                <PageHeader section="me" />

                {/* Who: avatar · name · plan */}
                <div className="me-hero" data-tour="profile-hero">
                    <AvatarEditor user={user} />
                    <div className="me-hero-info">
                        <p className="me-name">{displayName}</p>
                        {!planLoading && (
                            <Link to="/pricing" className={`sys-pill tone-${planTone(plan).tone} me-plan`}>{planLabel} plan</Link>
                        )}
                    </div>
                </div>

                <ul className="sys-rows" aria-label="Account">
                    <li>
                        <Row leading={<UserRound size={18} aria-hidden="true" />} title="Profile"
                            sub={user?.email} onClick={() => setView('profile')} />
                    </li>
                    <li>
                        <Row leading={<CreditCard size={18} aria-hidden="true" />} title="Plan & billing"
                            meta={planLoading ? undefined : planLabel} metaTone={planTone(plan).tone} to="/pricing" />
                    </li>
                    <li>
                        <Row leading={<Bell size={18} aria-hidden="true" />} title="Job alerts" onClick={() => setView('alerts')} />
                    </li>
                    <li>
                        <Row leading={<LifeBuoy size={18} aria-hidden="true" />} title="Help" onClick={() => setView('help')} />
                    </li>
                    <li>
                        <Row leading={<LogOut size={18} aria-hidden="true" />} title={signingOut ? 'Signing out…' : 'Sign out'}
                            chevron={false} disabled={signingOut} onClick={handleLogout} className="me-signout" />
                    </li>
                </ul>
            </PageContainer>

            {/* Profile: details, referral profile, progress, password */}
            <Sheet open={view === 'profile'} onClose={close} title="Profile" size="full">
                <div className="me-sheet">
                    <section className="me-block" aria-labelledby="pf-account-h">
                        <h2 className="me-block-title" id="pf-account-h">Account</h2>
                        {editNameOpen ? (
                            <form onSubmit={handleUpdateName} className="profile-form">
                                <div className="sys-field">
                                    <label htmlFor="pf-name" className="sys-field-label">Full name</label>
                                    <input id="pf-name" type="text" className="input-field" placeholder="Jane Doe"
                                        autoComplete="name" value={editName} onChange={e => setEditName(e.target.value)} required autoFocus />
                                </div>
                                {nameStatus.msg && (
                                    <p className={`sys-note ${nameStatus.type === 'error' ? 'is-danger' : 'is-ok'}`} role="status">{nameStatus.msg}</p>
                                )}
                                <div className="profile-actions">
                                    <Button onClick={() => setEditNameOpen(false)}>Cancel</Button>
                                    <Button type="submit" variant="primary" busy={nameLoading} busyLabel="Saving…">Save</Button>
                                </div>
                            </form>
                        ) : (
                            <div className="profile-kvs">
                                <KV label="Name">
                                    <span className="profile-kv-text">{displayName}</span>
                                    <button type="button" className="link-btn" onClick={() => setEditNameOpen(true)}>Edit</button>
                                </KV>
                                <KV label="Email"><span className="profile-kv-text">{user?.email || '—'}</span></KV>
                                <KV label="Joined"><span className="profile-kv-text">{joined}</span></KV>
                                <KV label="Sign-in"><span className="profile-kv-text" style={{ textTransform: 'capitalize' }}>{provider}</span></KV>
                            </div>
                        )}
                    </section>

                    <ReferralProfileCard user={user} />
                    <ProgressSection user={user} />

                    {/* Password: only for email/password accounts */}
                    {!isOAuth && (
                        <section className="me-block" aria-labelledby="pf-security-h">
                            <h2 className="me-block-title" id="pf-security-h">Password</h2>
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
                </div>
            </Sheet>

            <Sheet open={view === 'alerts'} onClose={close} title="Job alerts" description="Get an email when these companies post jobs.">
                <div className="me-sheet"><CompanySubscriptionsCard /></div>
            </Sheet>

            <Sheet open={view === 'help'} onClose={close} title="Help" size="full">
                <div className="me-sheet">
                    <ul className="sys-rows" aria-label="Help pages">
                        {HELP_LINKS.map(([to, label]) => (
                            <li key={to}><Row title={label} to={to} /></li>
                        ))}
                    </ul>
                    <FeedbackSection />
                </div>
            </Sheet>
        </>
    )
}

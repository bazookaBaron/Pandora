import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import Navbar from '../components/Navbar'

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
    const colors = ['#6366f1', '#8b5cf6', '#a855f7', '#ec4899', '#06b6d4', '#10b981', '#f59e0b']
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
        { pct: '100%', color: '#34d399', text: 'Strong 🎉' },
    ]
    const level = levels[score]
    if (!password) return null
    return (
        <div style={{ marginTop: 8 }}>
            <div className="pw-strength">
                <div className="pw-strength-bar" style={{ width: level.pct, background: level.color }} />
            </div>
            {level.text && <p className="field-hint" style={{ marginTop: 4 }}>{level.text}</p>}
        </div>
    )
}

export default function ProfilePage() {
    const { user, logout } = useAuth()
    const navigate = useNavigate()

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
            // Reload to refresh user metadata from context
            window.location.reload()
        }
    }

    const handleLogout = async () => {
        await logout()
        navigate('/auth')
    }

    return (
        <>
            <Navbar />
            <div className="bg-blob blob-1" />
            <div className="bg-blob blob-2" />
            <div className="bg-blob blob-3" />

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
                        <span className="profile-badge">Free Plan</span>
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
                        <span className="profile-field-label">Provider</span>
                        <span className="profile-field-value" style={{ textTransform: 'capitalize' }}>{provider}</span>
                    </div>
                </section>

                {/* Security */}
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
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                            style={{ width: 'auto', padding: '12px 28px', fontSize: '.9rem' }}
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

                {/* Danger Zone */}
                <section className="card profile-card danger-card">
                    <h2 className="profile-section-title danger-title">Danger Zone</h2>
                    <p className="danger-desc">Sign out from all devices.</p>
                    <div className="danger-actions">
                        <button className="danger-btn" onClick={handleLogout}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                            </svg>
                            Sign Out
                        </button>
                    </div>
                </section>
            </main>

            {/* Edit Name Modal */}
            {editNameOpen && (
                <div
                    className="modal-overlay"
                    onClick={e => { if (e.target === e.currentTarget) setEditNameOpen(false) }}
                >
                    <div className="modal-card card">
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
                                <button type="submit" className="primary-btn" disabled={nameLoading} style={{ flex: 1, padding: 12 }}>
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

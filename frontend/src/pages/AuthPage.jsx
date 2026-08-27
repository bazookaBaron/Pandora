import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

function Logo() {
    return (
        <svg width="40" height="40" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="url(#logo-auth)" />
            <path d="M10 22V10h4l4 7 4-7h4v12h-3.5v-7.5L19 19h-2.5l-3.5-4.5V22H10z" fill="white" />
            <defs>
                <linearGradient id="logo-auth" x1="0" y1="0" x2="32" y2="32">
                    <stop stopColor="#6366f1" />
                    <stop offset="1" stopColor="#a855f7" />
                </linearGradient>
            </defs>
        </svg>
    )
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

export default function AuthPage() {
    const { session } = useAuth()
    const navigate = useNavigate()
    const [tab, setTab] = useState('login')
    const [status, setStatus] = useState({ msg: '', type: '' })
    const [loading, setLoading] = useState(false)

    // Login fields
    const [loginEmail, setLoginEmail] = useState('')
    const [loginPw, setLoginPw] = useState('')
    const [showLoginPw, setShowLoginPw] = useState(false)

    // Signup fields
    const [signupName, setSignupName] = useState('')
    const [signupEmail, setSignupEmail] = useState('')
    const [signupPw, setSignupPw] = useState('')
    const [showSignupPw, setShowSignupPw] = useState(false)

    useEffect(() => {
        if (session) navigate('/', { replace: true })
    }, [session, navigate])

    const clearStatus = () => setStatus({ msg: '', type: '' })

    const handleLogin = async (e) => {
        e.preventDefault()
        setLoading(true)
        clearStatus()
        const { error } = await supabase.auth.signInWithPassword({ email: loginEmail, password: loginPw })
        setLoading(false)
        if (error) {
            setStatus({ msg: error.message, type: 'error' })
        } else {
            setStatus({ msg: 'Signed in! Redirecting…', type: 'ok' })
            setTimeout(() => navigate('/'), 600)
        }
    }

    const handleSignup = async (e) => {
        e.preventDefault()
        setLoading(true)
        clearStatus()
        const { error } = await supabase.auth.signUp({
            email: signupEmail,
            password: signupPw,
            options: { data: { full_name: signupName } },
        })
        setLoading(false)
        if (error) {
            setStatus({ msg: error.message, type: 'error' })
        } else {
            setStatus({ msg: 'Account created! Check your email to confirm, then sign in.', type: 'ok' })
        }
    }

    const handleForgotPassword = async () => {
        if (!loginEmail) { setStatus({ msg: 'Enter your email first.', type: 'error' }); return }
        setStatus({ msg: 'Sending reset link…', type: '' })
        const { error } = await supabase.auth.resetPasswordForEmail(loginEmail, {
            redirectTo: `${window.location.origin}/auth`,
        })
        setStatus(error
            ? { msg: error.message, type: 'error' }
            : { msg: 'Password reset email sent!', type: 'ok' }
        )
    }

    return (
        <div className="auth-wrap">
            {/* Blobs */}
            <div className="bg-blob blob-1" />
            <div className="bg-blob blob-2" />
            <div className="bg-blob blob-3" />

            <div style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 420, margin: '0 auto' }}>
                {/* Logo */}
                <div className="auth-logo">
                    <Logo />
                    <div>
                        <h1 className="auth-brand">Resume Optimizer</h1>
                        <p className="auth-tagline">AI-Powered ATS Tailoring</p>
                    </div>
                </div>

                {/* Card */}
                <div className="auth-card card">
                    {/* Tabs */}
                    <div className="auth-tabs">
                        <button
                            className={`auth-tab${tab === 'login' ? ' active' : ''}`}
                            onClick={() => { setTab('login'); clearStatus() }}
                        >Sign In</button>
                        <button
                            className={`auth-tab${tab === 'signup' ? ' active' : ''}`}
                            onClick={() => { setTab('signup'); clearStatus() }}
                        >Create Account</button>
                    </div>

                    {/* Login Form */}
                    {tab === 'login' && (
                        <form onSubmit={handleLogin} className="auth-form">
                            <div className="form-group">
                                <label className="field-label">Email</label>
                                <input
                                    type="email" className="input-field" placeholder="you@example.com"
                                    value={loginEmail} onChange={e => setLoginEmail(e.target.value)} required
                                />
                            </div>
                            <div className="form-group">
                                <label className="field-label">Password</label>
                                <div className="pw-row">
                                    <input
                                        type={showLoginPw ? 'text' : 'password'} className="input-field"
                                        placeholder="••••••••" value={loginPw}
                                        onChange={e => setLoginPw(e.target.value)} required
                                    />
                                    <button type="button" className="icon-btn" onClick={() => setShowLoginPw(v => !v)}>
                                        <EyeIcon open={showLoginPw} />
                                    </button>
                                </div>
                            </div>
                            <div className="forgot-row">
                                <button type="button" className="link-btn" onClick={handleForgotPassword}>
                                    Forgot password?
                                </button>
                            </div>
                            <button type="submit" className="primary-btn auth-submit-btn" disabled={loading}>
                                <LoginIcon />
                                <span>{loading ? 'Signing In…' : 'Sign In'}</span>
                                {loading && <div className="spinner" />}
                            </button>
                        </form>
                    )}

                    {/* Signup Form */}
                    {tab === 'signup' && (
                        <form onSubmit={handleSignup} className="auth-form">
                            <div className="form-group">
                                <label className="field-label">Full Name</label>
                                <input
                                    type="text" className="input-field" placeholder="Jane Doe"
                                    value={signupName} onChange={e => setSignupName(e.target.value)} required
                                />
                            </div>
                            <div className="form-group">
                                <label className="field-label">Email</label>
                                <input
                                    type="email" className="input-field" placeholder="you@example.com"
                                    value={signupEmail} onChange={e => setSignupEmail(e.target.value)} required
                                />
                            </div>
                            <div className="form-group">
                                <label className="field-label">Password</label>
                                <div className="pw-row">
                                    <input
                                        type={showSignupPw ? 'text' : 'password'} className="input-field"
                                        placeholder="Min. 8 characters" minLength={8}
                                        value={signupPw} onChange={e => setSignupPw(e.target.value)} required
                                    />
                                    <button type="button" className="icon-btn" onClick={() => setShowSignupPw(v => !v)}>
                                        <EyeIcon open={showSignupPw} />
                                    </button>
                                </div>
                                <PwStrengthBar password={signupPw} />
                            </div>
                            <button type="submit" className="primary-btn auth-submit-btn" disabled={loading}>
                                <SignupIcon />
                                <span>{loading ? 'Creating…' : 'Create Account'}</span>
                                {loading && <div className="spinner" />}
                            </button>
                        </form>
                    )}

                    {/* Status */}
                    {status.msg && (
                        <div className={`auth-status auth-status--${status.type}`}>
                            {status.msg}
                        </div>
                    )}
                </div>

                <p className="auth-footer-note">
                    By continuing, you agree to our <span className="accent-link">Terms</span> &amp; <span className="accent-link">Privacy Policy</span>.
                </p>
            </div>
        </div>
    )
}

// ── Inline micro-icons ─────────────────────────────────────────────
function EyeIcon({ open }) {
    return open ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
    ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
        </svg>
    )
}

function LoginIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" />
        </svg>
    )
}

function SignupIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6" />
        </svg>
    )
}

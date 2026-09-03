import { useEffect, useRef, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useCompanyOptions } from '../lib/useReferrals'
import { track, EVENTS } from '../lib/analytics'

// Free-text company field with a suggestion dropdown. Suggestions need an
// authenticated session (the catalog endpoint is bearer-gated), so on the
// public auth screen this degrades gracefully to a plain text input.
function CompanyAutocomplete({ value, onChange, placeholder = 'Start typing a company…', required = false }) {
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
                required={required}
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
    const [signupCompany, setSignupCompany] = useState('')
    const [signupPosition, setSignupPosition] = useState('')
    const [signupYoe, setSignupYoe] = useState('')

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
            track(EVENTS.LOGIN, { method: 'password' })
            setStatus({ msg: 'Signed in! Redirecting…', type: 'ok' })
            setTimeout(() => navigate('/'), 600)
        }
    }

    const handleSignup = async (e) => {
        e.preventDefault()
        clearStatus()
        const company = signupCompany.trim()
        const position = signupPosition.trim()
        const yoeNum = Number(signupYoe)
        if (!company || !position || signupYoe === '' || Number.isNaN(yoeNum) || yoeNum < 0) {
            setStatus({ msg: 'Company, position, and years of experience are required.', type: 'error' })
            return
        }
        setLoading(true)
        const { error } = await supabase.auth.signUp({
            email: signupEmail,
            password: signupPw,
            options: {
                data: {
                    full_name: signupName,
                    // Referral-profile fields — the DB trigger reads these into
                    // `profiles` on account creation.
                    company,
                    position,
                    years_of_experience: yoeNum,
                },
            },
        })
        setLoading(false)
        if (error) {
            setStatus({ msg: error.message, type: 'error' })
        } else {
            track(EVENTS.SIGNUP, { method: 'password' })
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

    const handleGoogleLogin = async () => {
        setLoading(true)
        clearStatus()
        // Fires before the OAuth redirect navigates away — posthog batches to
        // localStorage so it still flushes. Covers both Google signup and login.
        track(EVENTS.GOOGLE_LOGIN, { method: 'google' })
        const { error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: `${window.location.origin}/`,
            },
        })
        if (error) {
            setStatus({ msg: error.message, type: 'error' })
            setLoading(false)
        }
        // On success, Supabase redirects to Google — no need to setLoading(false)
    }

    return (
        <div className="auth-wrap">
            <div style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 400, margin: '0 auto' }}>
                {/* Logo */}
                <div className="auth-logo">
                    <img src="/vloombox-logo.svg" alt="" width="56" height="56" className="logo-mark" style={{ width: 56, height: 56, padding: 0, background: 'none' }} />
                    <div>
                        <h1 className="auth-brand">Vloombox</h1>
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

                    {/* Google OAuth Button */}
                    <button className="google-btn" onClick={handleGoogleLogin} disabled={loading} type="button">
                        <GoogleIcon />
                        Continue with Google
                    </button>

                    <div className="or-divider">or</div>

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
                            <div className="form-group">
                                <label className="field-label">Current company</label>
                                <CompanyAutocomplete value={signupCompany} onChange={setSignupCompany} placeholder="e.g. Google" required />
                            </div>
                            <div className="form-group">
                                <label className="field-label">Your position / title</label>
                                <input
                                    type="text" className="input-field" placeholder="e.g. Senior Software Engineer" required
                                    value={signupPosition} onChange={e => setSignupPosition(e.target.value)}
                                />
                            </div>
                            <div className="form-group">
                                <label className="field-label">Years of experience</label>
                                <input
                                    type="number" min={0} step={0.5} className="input-field" placeholder="e.g. 4" required
                                    value={signupYoe} onChange={e => setSignupYoe(e.target.value)}
                                />
                                <p className="field-hint">Used to match you with referral requests. You can edit this later in your profile.</p>
                            </div>
                            <button type="submit" className="primary-btn auth-submit-btn" disabled={loading}>
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
                    By continuing, you agree to our <Link className="accent-link" to="/terms">Terms</Link> &amp; <Link className="accent-link" to="/privacy">Privacy Policy</Link>.
                </p>
            </div>
        </div>
    )
}

// ── Micro-icons ───────────────────────────────────────────────────────
function EyeIcon({ open }) {
    return open ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
    ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
        </svg>
    )
}

function GoogleIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
        </svg>
    )
}

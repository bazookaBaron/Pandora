import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

function getInitials(user) {
    const name =
        user?.user_metadata?.full_name ||
        user?.user_metadata?.name ||
        user?.email?.split('@')[0] ||
        'U'
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

export default function Navbar() {
    const { user, logout } = useAuth()
    const navigate = useNavigate()

    const handleLogout = async () => {
        await logout()
        navigate('/auth')
    }

    return (
        <nav className="top-nav">
            <Link to="/" className="nav-brand">
                <svg width="26" height="26" viewBox="0 0 32 32" fill="none">
                    <rect width="32" height="32" rx="8" fill="url(#logo-nav)" />
                    <path d="M10 22V10h4l4 7 4-7h4v12h-3.5v-7.5L19 19h-2.5l-3.5-4.5V22H10z" fill="white" />
                    <defs>
                        <linearGradient id="logo-nav" x1="0" y1="0" x2="32" y2="32">
                            <stop stopColor="#6366f1" />
                            <stop offset="1" stopColor="#a855f7" />
                        </linearGradient>
                    </defs>
                </svg>
                Resume Optimizer
            </Link>

            <div className="nav-actions">
                <Link to="/profile" className="nav-avatar-btn" title="View Profile">
                    <span
                        className="nav-avatar"
                        style={{ background: stringToColor(user?.email) }}
                    >
                        {getInitials(user)}
                    </span>
                    <span className="nav-user-name">
                        {user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Profile'}
                    </span>
                </Link>

                <button className="nav-logout-btn" onClick={handleLogout}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                    </svg>
                    Sign Out
                </button>
            </div>
        </nav>
    )
}

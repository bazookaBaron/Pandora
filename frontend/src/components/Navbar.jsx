import { Link, useNavigate, useLocation } from 'react-router-dom'
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
    const colors = ['#22d3ee', '#f472b6', '#4ade80', '#facc15', '#a78bfa', '#fb923c', '#60a5fa']
    return colors[Math.abs(hash) % colors.length]
}

export default function Navbar() {
    const { user, logout } = useAuth()
    const navigate = useNavigate()
    const location = useLocation()

    const handleLogout = async () => {
        await logout()
        navigate('/auth')
    }

    return (
        <nav className="top-nav">
            <Link to="/" className="nav-brand">
                <span className="nav-pulse" />
                RESUMEOPT
            </Link>

            <div className="nav-actions">
                <Link
                    to="/"
                    className={`nav-pill${location.pathname === '/' ? ' active' : ''}`}
                >
                    Optimizer
                </Link>

                <Link
                    to="/profile"
                    className={`nav-pill${location.pathname === '/profile' ? ' active' : ''}`}
                >
                    <span
                        className="nav-avatar"
                        style={{ background: stringToColor(user?.email), width: 18, height: 18, fontSize: '0.55rem', borderRadius: 3 }}
                    >
                        {getInitials(user)}
                    </span>
                    {user?.user_metadata?.full_name?.split(' ')[0] || user?.email?.split('@')[0] || 'Profile'}
                </Link>

                <button className="nav-pill danger" onClick={handleLogout}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                    </svg>
                    Exit
                </button>
            </div>
        </nav>
    )
}

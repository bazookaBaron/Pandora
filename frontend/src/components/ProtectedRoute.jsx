import { Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export default function ProtectedRoute({ children }) {
    const { session, loading } = useAuth()

    if (loading) {
        return (
            <div className="loading-screen">
                <div className="spinner-lg"></div>
            </div>
        )
    }

    if (!session) {
        return <Navigate to="/auth" replace />
    }

    return children
}

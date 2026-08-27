import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from './contexts/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import CommandPalette from './components/shared/CommandPalette'

import AuthPage from './pages/AuthPage'
import HomePage from './pages/HomePage'
import ProfilePage from './pages/ProfilePage'
import DashboardPage from './pages/DashboardPage'
import DSAListPage from './pages/dsa/DSAListPage'
import DSACompanyPage from './pages/dsa/DSACompanyPage'
import LLDListPage from './pages/lld/LLDListPage'
import LLDProblemPage from './pages/lld/LLDProblemPage'

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            retry: 1,
        }
    }
})

export default function App() {
    return (
        <QueryClientProvider client={queryClient}>
            <BrowserRouter>
                <AuthProvider>
                    <CommandPalette />
                    <Routes>
                        <Route path="/auth" element={<AuthPage />} />
                        <Route path="/" element={<ProtectedRoute><HomePage /></ProtectedRoute>} />
                        <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
                        <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
                        <Route path="/dsa" element={<ProtectedRoute><DSAListPage /></ProtectedRoute>} />
                        <Route path="/dsa/company/:companyName" element={<ProtectedRoute><DSACompanyPage /></ProtectedRoute>} />
                        <Route path="/lld" element={<ProtectedRoute><LLDListPage /></ProtectedRoute>} />
                        <Route path="/lld/:slug" element={<ProtectedRoute><LLDProblemPage /></ProtectedRoute>} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </AuthProvider>
            </BrowserRouter>
        </QueryClientProvider>
    )
}

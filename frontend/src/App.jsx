import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from './contexts/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import CommandPalette from './components/shared/CommandPalette'

import AuthPage from './pages/AuthPage'
import HomePage from './pages/HomePage'
import ProfilePage from './pages/ProfilePage'
import PricingPage from './pages/PricingPage'
import DSAListPage from './pages/dsa/DSAListPage'
import DSACompanyPage from './pages/dsa/DSACompanyPage'
import LLDListPage from './pages/lld/LLDListPage'
import LLDProblemPage from './pages/lld/LLDProblemPage'
import HLDListPage from './pages/hld/HLDListPage'
import HLDWorkspacePage from './pages/hld/HLDWorkspacePage'
import InterviewPage from './pages/interview/InterviewPage'

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
                        <Route path="/pricing" element={<ProtectedRoute><PricingPage /></ProtectedRoute>} />
                        <Route path="/dashboard" element={<Navigate to="/profile" replace />} />
                        <Route path="/dsa" element={<ProtectedRoute><DSAListPage /></ProtectedRoute>} />
                        <Route path="/dsa/company/:companyName" element={<ProtectedRoute><DSACompanyPage /></ProtectedRoute>} />
                        <Route path="/lld" element={<ProtectedRoute><LLDListPage /></ProtectedRoute>} />
                        <Route path="/lld/:slug" element={<ProtectedRoute><LLDProblemPage /></ProtectedRoute>} />
                        <Route path="/hld" element={<ProtectedRoute><HLDListPage /></ProtectedRoute>} />
                        <Route path="/hld/:id" element={<ProtectedRoute><HLDWorkspacePage /></ProtectedRoute>} />
                        <Route path="/interview" element={<ProtectedRoute><InterviewPage /></ProtectedRoute>} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </AuthProvider>
            </BrowserRouter>
        </QueryClientProvider>
    )
}

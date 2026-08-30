import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from './contexts/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import CommandPalette from './components/shared/CommandPalette'
import Footer from './components/Footer'
import { RouteErrorBoundary } from './components/shared/ErrorBoundary'
import SessionExpiredBanner from './components/shared/SessionExpiredBanner'

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
import ReferralsPage from './pages/referrals/ReferralsPage'
import JobsPage from './pages/jobs/JobsPage'
import { TermsPage, PrivacyPage, RefundPage, ContactPage } from './pages/LegalPages'
import {
    AboutPage,
    BlogPage,
    QuestionsPage,
    GuidelinesPage,
    LegalPrivacyScaffold,
    LegalTermsScaffold,
    FAQPage,
} from './pages/StaticPages'

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
                    <SessionExpiredBanner />
                    <RouteErrorBoundary>
                    <Routes>
                        <Route path="/auth" element={<AuthPage />} />
                        <Route path="/" element={<HomePage />} />
                        <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
                        <Route path="/pricing" element={<PricingPage />} />
                        <Route path="/terms" element={<TermsPage />} />
                        <Route path="/privacy" element={<PrivacyPage />} />
                        <Route path="/refunds" element={<RefundPage />} />
                        <Route path="/contact" element={<ContactPage />} />
                        <Route path="/about" element={<AboutPage />} />
                        <Route path="/blog" element={<BlogPage />} />
                        <Route path="/questions" element={<QuestionsPage />} />
                        <Route path="/faq" element={<FAQPage />} />
                        <Route path="/legal/privacy" element={<LegalPrivacyScaffold />} />
                        <Route path="/legal/terms" element={<LegalTermsScaffold />} />
                        <Route path="/legal/guidelines" element={<GuidelinesPage />} />
                        <Route path="/dashboard" element={<Navigate to="/profile" replace />} />
                        <Route path="/dsa" element={<ProtectedRoute><DSAListPage /></ProtectedRoute>} />
                        <Route path="/dsa/company/:companyName" element={<ProtectedRoute><DSACompanyPage /></ProtectedRoute>} />
                        <Route path="/lld" element={<ProtectedRoute><LLDListPage /></ProtectedRoute>} />
                        <Route path="/lld/:slug" element={<ProtectedRoute><LLDProblemPage /></ProtectedRoute>} />
                        <Route path="/hld" element={<ProtectedRoute><HLDListPage /></ProtectedRoute>} />
                        <Route path="/hld/:id" element={<ProtectedRoute><HLDWorkspacePage /></ProtectedRoute>} />
                        <Route path="/interview" element={<ProtectedRoute><InterviewPage /></ProtectedRoute>} />
                        <Route path="/referrals" element={<ProtectedRoute><ReferralsPage /></ProtectedRoute>} />
                        <Route path="/jobs" element={<ProtectedRoute><JobsPage /></ProtectedRoute>} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                    </RouteErrorBoundary>
                    {/* Global footer — appears under every route. */}
                    <Footer />
                </AuthProvider>
            </BrowserRouter>
        </QueryClientProvider>
    )
}

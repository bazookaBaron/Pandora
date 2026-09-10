import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
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
    BlogPostPage,
    GuidelinesPage,
    LegalPrivacyScaffold,
    LegalTermsScaffold,
    FAQPage,
    SubscriptionSuccessPage,
} from './pages/StaticPages'

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            retry: 1,
            // Phase 0.6: stop the refetch-on-every-focus / refetch-on-remount
            // storm. Per-query staleTime overrides where a page wants fresher.
            staleTime: 30_000,
            gcTime: 10 * 60_000,
            refetchOnWindowFocus: false,
        }
    }
})

// Don't let the browser restore the previous scroll position on reload/back —
// every page should start at the top.
if (typeof window !== 'undefined' && 'scrollRestoration' in window.history) {
    window.history.scrollRestoration = 'manual'
}

// On every route change (and initial load), jump the viewport back to the top.
// In-page anchor links (#hash) are left alone so they can still scroll to target.
function ScrollToTop() {
    const { pathname, hash } = useLocation()
    useEffect(() => {
        if (hash) return
        window.scrollTo(0, 0)
        document.documentElement.scrollTop = 0
        document.body.scrollTop = 0
    }, [pathname, hash])
    return null
}

export default function App() {
    return (
        <QueryClientProvider client={queryClient}>
            <BrowserRouter>
                <AuthProvider>
                    <ScrollToTop />
                    <CommandPalette />
                    <SessionExpiredBanner />
                    <RouteErrorBoundary>
                    <Routes>
                        <Route path="/auth" element={<AuthPage />} />
                        {/* Content is browsable logged-out (free-tier view); the
                            server applies free caps for anonymous requests. Only
                            /profile, /subscription/success stay behind auth. */}
                        <Route path="/" element={<JobsPage />} />
                        <Route path="/optimizer" element={<HomePage />} />
                        <Route path="/jobs" element={<Navigate to="/" replace />} />
                        <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
                        <Route path="/pricing" element={<PricingPage />} />
                        <Route path="/terms" element={<TermsPage />} />
                        <Route path="/privacy" element={<PrivacyPage />} />
                        <Route path="/refunds" element={<RefundPage />} />
                        <Route path="/contact" element={<ContactPage />} />
                        <Route path="/about" element={<AboutPage />} />
                        <Route path="/blog" element={<BlogPage />} />
                        <Route path="/blog/:slug" element={<BlogPostPage />} />
                        {/* "Question Bank" = the existing Interview Questions page. */}
                        <Route path="/questions" element={<Navigate to="/interview" replace />} />
                        <Route path="/faq" element={<FAQPage />} />
                        <Route path="/legal/privacy" element={<LegalPrivacyScaffold />} />
                        <Route path="/legal/terms" element={<LegalTermsScaffold />} />
                        <Route path="/legal/guidelines" element={<GuidelinesPage />} />
                        <Route path="/subscription/success" element={<ProtectedRoute><SubscriptionSuccessPage /></ProtectedRoute>} />
                        <Route path="/dashboard" element={<Navigate to="/profile" replace />} />
                        <Route path="/dsa" element={<DSAListPage />} />
                        <Route path="/dsa/company/:companyName" element={<DSACompanyPage />} />
                        <Route path="/lld" element={<LLDListPage />} />
                        <Route path="/lld/:slug" element={<LLDProblemPage />} />
                        <Route path="/hld" element={<HLDListPage />} />
                        <Route path="/hld/:id" element={<HLDWorkspacePage />} />
                        <Route path="/interview" element={<InterviewPage />} />
                        <Route path="/referrals" element={<ReferralsPage />} />
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

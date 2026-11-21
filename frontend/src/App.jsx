import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from './contexts/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import CommandPalette from './components/shared/CommandPalette'
import Footer from './components/Footer'
import { RouteErrorBoundary } from './components/shared/ErrorBoundary'
import SessionExpiredBanner from './components/shared/SessionExpiredBanner'
import FirstRunHost from './components/onboarding/FirstRunHost'
import { usePlanChangeRefetch } from './lib/useEntitlements'
import { trackPageview } from './lib/analytics'
import { createMutationCache } from './lib/mutationCache'

// Phase 1.5: every page component is code-split behind React.lazy so the
// production entry chunk no longer ships reactflow / monaco / jszip /
// html-to-image / react-markdown to routes that don't use them.
const AuthPage = lazy(() => import('./pages/AuthPage'))
const HomePage = lazy(() => import('./pages/HomePage'))
const ProfilePage = lazy(() => import('./pages/ProfilePage'))
const PricingPage = lazy(() => import('./pages/PricingPage'))
const DSAListPage = lazy(() => import('./pages/dsa/DSAListPage'))
const DSACompanyPage = lazy(() => import('./pages/dsa/DSACompanyPage'))
const LLDListPage = lazy(() => import('./pages/lld/LLDListPage'))
const LLDProblemPage = lazy(() => import('./pages/lld/LLDProblemPage'))
const HLDListPage = lazy(() => import('./pages/hld/HLDListPage'))
const HLDWorkspacePage = lazy(() => import('./pages/hld/HLDWorkspacePage'))
const InterviewPage = lazy(() => import('./pages/interview/InterviewPage'))
const ReferralsPage = lazy(() => import('./pages/referrals/ReferralsPage'))
const JobsPage = lazy(() => import('./pages/jobs/JobsPage'))
const JobsCompanyPage = lazy(() => import('./pages/jobs/JobsCompanyPage'))
const AutoApplyLanding = lazy(() => import('./pages/autoapply/AutoApplyLanding'))
const AutoApplyAccount = lazy(() => import('./pages/autoapply/AccountPage'))
const AutoApplyBuy = lazy(() => import('./pages/autoapply/BuyPage'))
const AutoApplyBatchDetail = lazy(() => import('./pages/autoapply/BatchDetailPage'))
const AutoApplyNeedsYou = lazy(() => import('./pages/autoapply/NeedsYouPage'))
const AutoApplyInbox = lazy(() => import('./pages/autoapply/InboxPage'))
const AutoApplyHealth = lazy(() => import('./pages/autoapply/HealthPage'))

const TermsPage = lazy(() => import('./pages/LegalPages').then(m => ({ default: m.TermsPage })))
const PrivacyPage = lazy(() => import('./pages/LegalPages').then(m => ({ default: m.PrivacyPage })))
const RefundPage = lazy(() => import('./pages/LegalPages').then(m => ({ default: m.RefundPage })))
const ContactPage = lazy(() => import('./pages/LegalPages').then(m => ({ default: m.ContactPage })))

const AboutPage = lazy(() => import('./pages/StaticPages').then(m => ({ default: m.AboutPage })))
const BlogPage = lazy(() => import('./pages/StaticPages').then(m => ({ default: m.BlogPage })))
const BlogPostPage = lazy(() => import('./pages/StaticPages').then(m => ({ default: m.BlogPostPage })))
const GuidelinesPage = lazy(() => import('./pages/StaticPages').then(m => ({ default: m.GuidelinesPage })))
const LegalPrivacyScaffold = lazy(() => import('./pages/StaticPages').then(m => ({ default: m.LegalPrivacyScaffold })))
const LegalTermsScaffold = lazy(() => import('./pages/StaticPages').then(m => ({ default: m.LegalTermsScaffold })))
const FAQPage = lazy(() => import('./pages/StaticPages').then(m => ({ default: m.FAQPage })))
const SubscriptionSuccessPage = lazy(() => import('./pages/StaticPages').then(m => ({ default: m.SubscriptionSuccessPage })))

// Key problem pages by their route param so navigating /lld/a -> /lld/b (e.g.
// from the command palette) remounts with fresh state instead of carrying the
// previous problem's editor/whiteboard state over.
function KeyedLLDProblem() {
    const { slug } = useParams()
    return <LLDProblemPage key={slug} />
}
function KeyedHLDWorkspace() {
    const { id } = useParams()
    return <HLDWorkspacePage key={id} />
}

const queryClient = new QueryClient({
    mutationCache: createMutationCache(),
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

// SPA pageviews: posthog-js is initialised with capture_pageview:false, and
// nothing called trackPageview(), so PostHog recorded zero $pageview events
// (verified 2026-11-13: none in 30 days). Fire one per client-side navigation.
function PageviewTracker() {
    const { pathname } = useLocation()
    useEffect(() => {
        trackPageview()
    }, [pathname])
    return null
}

function PlanChangeRefetch() {
    usePlanChangeRefetch()
    return null
}

// Shown while a lazy route chunk is in flight. Matches ProtectedRoute's markup.
// Redirect that keeps ?query and #hash (old /autoapply/setup?step=x#y deep links).
// `to` may carry its own ?query / #hash: those are merged with the incoming ones
// (incoming query wins on key clash; incoming hash wins, else the target's).
function RedirectKeep({ to }) {
    const { search, hash } = useLocation()
    const [pathAndQuery, toHash = ''] = to.split('#')
    const [pathname, toQuery = ''] = pathAndQuery.split('?')
    const merged = new URLSearchParams(toQuery)
    new URLSearchParams(search).forEach((v, k) => merged.set(k, v))
    const qs = merged.toString()
    return <Navigate to={{ pathname, search: qs ? `?${qs}` : '', hash: hash || (toHash ? `#${toHash}` : '') }} replace />
}

function RouteFallback() {
    return (
        <div className="loading-screen">
            <div className="spinner-lg"></div>
        </div>
    )
}

export default function App() {
    return (
        <QueryClientProvider client={queryClient}>
            <BrowserRouter>
                <AuthProvider>
                    <ScrollToTop />
                    <PageviewTracker />
                    <PlanChangeRefetch />
                    <CommandPalette />
                    <SessionExpiredBanner />
                    <FirstRunHost />
                    <RouteErrorBoundary>
                    <Suspense fallback={<RouteFallback />}>
                    <Routes>
                        <Route path="/auth" element={<AuthPage />} />
                        {/* Content is browsable logged-out (free-tier view); the
                            server applies free caps for anonymous requests. Only
                            /profile, /subscription/success stay behind auth. */}
                        <Route path="/" element={<JobsPage />} />
                        <Route path="/optimizer" element={<HomePage />} />
                        <Route path="/jobs" element={<Navigate to="/" replace />} />
                        <Route path="/jobs/company/:slug" element={<JobsCompanyPage />} />
                        <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
                        <Route path="/pricing" element={<ProtectedRoute><PricingPage /></ProtectedRoute>} />
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
                        <Route path="/lld/:slug" element={<KeyedLLDProblem />} />
                        <Route path="/hld" element={<HLDListPage />} />
                        <Route path="/hld/:id" element={<KeyedHLDWorkspace />} />
                        <Route path="/interview" element={<InterviewPage />} />
                        <Route path="/referrals" element={<ReferralsPage />} />
                        <Route path="/autoapply" element={<ProtectedRoute><AutoApplyLanding /></ProtectedRoute>} />
                        <Route path="/autoapply/account" element={<ProtectedRoute><AutoApplyAccount /></ProtectedRoute>} />
                        <Route path="/autoapply/setup" element={<RedirectKeep to="/autoapply/account" />} />
                        <Route path="/autoapply/profile" element={<RedirectKeep to="/autoapply/account" />} />
                        <Route path="/autoapply/accounts" element={<RedirectKeep to="/autoapply/account#sites" />} />
                        <Route path="/autoapply/stats" element={<RedirectKeep to="/autoapply/account#stats" />} />
                        <Route path="/autoapply/batches" element={<Navigate to="/autoapply" replace />} />
                        <Route path="/autoapply/interviews" element={<RedirectKeep to="/autoapply/inbox?f=interview" />} />
                        <Route path="/autoapply/buy" element={<ProtectedRoute><AutoApplyBuy /></ProtectedRoute>} />
                        <Route path="/autoapply/batches/:id" element={<ProtectedRoute><AutoApplyBatchDetail /></ProtectedRoute>} />
                        <Route path="/autoapply/needs-you" element={<ProtectedRoute><AutoApplyNeedsYou /></ProtectedRoute>} />
                        <Route path="/autoapply/inbox" element={<ProtectedRoute><AutoApplyInbox /></ProtectedRoute>} />
                        <Route path="/autoapply/admin/health" element={<ProtectedRoute><AutoApplyHealth /></ProtectedRoute>} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                    </Suspense>
                    </RouteErrorBoundary>
                    {/* Global footer — appears under every route. */}
                    <Footer />
                </AuthProvider>
            </BrowserRouter>
        </QueryClientProvider>
    )
}

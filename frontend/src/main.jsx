import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// Shared UI system (semantic tones, .sys-* classes) - must come right after the brand tokens.
import './styles/system.css'
// Page styles moved verbatim out of index.css; loaded globally so the cascade is unchanged.
import './styles/pages/jobs.css'
import './styles/pages/practice.css'
import './styles/pages/account.css'
import App from './App.jsx'
import { ThemeProvider } from './contexts/ThemeContext'
import { initAnalytics } from './lib/analytics'
import { ToastProvider } from './components/shared/Toaster'

// initAnalytics defers itself to requestIdleCallback and lazy-loads posthog-js.
initAnalytics()

// This module executing at all means the current index.html + entry chunk
// loaded fine — clear ErrorBoundary's one-shot reload guard so a LATER,
// unrelated chunk-load failure (a different lazy route, after yet another
// deploy) still gets its own auto-reload attempt instead of silently
// falling through to the manual error card because of an unrelated past
// incident earlier in this tab's session.
try { sessionStorage.removeItem('eb:chunk-reload-attempted') } catch { /* private mode */ }

createRoot(document.getElementById('root')).render(
    <StrictMode>
        <ThemeProvider>
            <ToastProvider>
                <App />
            </ToastProvider>
        </ThemeProvider>
    </StrictMode>,
)

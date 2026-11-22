import { Component } from 'react'
import { Link, useLocation } from 'react-router-dom'

// Every route is behind React.lazy(() => import(...)) with content-hashed
// chunk filenames. Between two deploys, an already-open tab's index.html
// (or a shared/CDN-cached copy of it, see server.js's public-route
// Cache-Control) can still reference a chunk hash the CURRENT deployment no
// longer has on disk — Vite doesn't keep old build output around. The
// dynamic import 404s, throws, and lands here looking exactly like a real
// app crash, even though the actual fix is just "load the current
// index.html" — a plain reload. Vite/Rolldown and most bundlers phrase this
// error consistently enough to detect by message.
const CHUNK_ERROR_RE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Loading chunk .* failed|Importing a module script failed/i
const RELOAD_GUARD_KEY = 'eb:chunk-reload-attempted'

function isChunkLoadError(error) {
    return !!error && CHUNK_ERROR_RE.test(String(error?.message || error))
}

// ── ErrorBoundary ─────────────────────────────────────────────────
// Catches a render/lifecycle crash in any child and shows a dark-mono
// fallback instead of a white screen. `fallback` is an optional render-prop
// `(error) => ReactNode`. Wrap it with <RouteErrorBoundary> so navigating to
// a new route clears a stuck error (the class is keyed on the pathname).
class ErrorBoundary extends Component {
    constructor(props) {
        super(props)
        this.state = { error: null }
    }

    static getDerivedStateFromError(error) {
        return { error }
    }

    componentDidCatch(error, info) {
        // eslint-disable-next-line no-console
        console.error('[ErrorBoundary]', error, info)

        // A stale-chunk 404 self-heals with one real reload (fetches the
        // current index.html + current chunk manifest) — no need to show
        // the scary card for something that isn't actually a bug in this
        // render. Guarded via sessionStorage so a genuinely broken deploy
        // (or an offline user) gets exactly one silent attempt, then falls
        // through to the normal card instead of reload-looping forever.
        if (isChunkLoadError(error)) {
            let alreadyTried = false
            try { alreadyTried = sessionStorage.getItem(RELOAD_GUARD_KEY) === '1' } catch { /* private mode */ }
            if (!alreadyTried) {
                try { sessionStorage.setItem(RELOAD_GUARD_KEY, '1') } catch { /* private mode — just reload once anyway */ }
                window.location.reload()
            }
        }
    }

    render() {
        const { error } = this.state
        if (!error) return this.props.children
        // Mid-reload for a chunk error (see componentDidCatch) — render
        // nothing rather than flashing the error card for the instant
        // before the reload takes effect.
        if (isChunkLoadError(error)) return null
        if (typeof this.props.fallback === 'function') return this.props.fallback(error)

        return (
            <div style={{
                minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 24, background: 'var(--surface)',
            }}>
                <div style={{
                    maxWidth: 420, width: '100%', display: 'flex', flexDirection: 'column',
                    alignItems: 'center', gap: 14, textAlign: 'center',
                    background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 14, padding: '36px 28px',
                }}>
                    <div aria-hidden style={{ fontSize: '2rem' }}>⚠️</div>
                    <h1 style={{ margin: 0, color: 'var(--bright)', fontWeight: 900, fontSize: '1.1rem', letterSpacing: '-0.02em' }}>
                        Something broke on this page.
                    </h1>
                    <p style={{ margin: 0, color: 'var(--accent)', fontSize: '0.82rem', lineHeight: 1.6 }}>
                        The page hit an unexpected error. Reloading usually clears it.
                    </p>
                    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                        <button
                            onClick={() => window.location.reload()}
                            style={{
                                padding: '8px 18px', borderRadius: 8, border: 'none', cursor: 'pointer',
                                background: 'linear-gradient(135deg, #22d3ee, #a78bfa)', color: 'var(--surface)',
                                fontWeight: 900, fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.06em',
                            }}
                        >
                            Reload
                        </button>
                        <Link
                            to="/"
                            style={{
                                padding: '8px 18px', borderRadius: 8, border: '1px solid var(--subtle)',
                                color: 'var(--accent)', fontWeight: 700, fontSize: '0.8rem', textDecoration: 'none',
                                display: 'inline-flex', alignItems: 'center',
                            }}
                        >
                            Go home
                        </Link>
                    </div>
                </div>
            </div>
        )
    }
}

// Functional wrapper: re-keys the boundary on route change so a crash on one
// page doesn't stick after the user navigates away.
export function RouteErrorBoundary({ children, fallback }) {
    const { pathname } = useLocation()
    return (
        <ErrorBoundary key={pathname} fallback={fallback}>
            {children}
        </ErrorBoundary>
    )
}

export default ErrorBoundary

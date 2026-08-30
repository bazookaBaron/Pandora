import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

// ── SessionExpiredBanner ──────────────────────────────────────────
// Listens for the global `auth:expired` event that apiClient fires when a
// mid-session token can't be refreshed. Shows a non-blocking fixed strip
// under the 56px navbar. Auto-hides once a session reappears (e.g. the user
// signs back in). Mounted once, near the router root.
export default function SessionExpiredBanner() {
    const [show, setShow] = useState(false)
    const navigate = useNavigate()

    useEffect(() => {
        const onExpired = () => setShow(true)
        window.addEventListener('auth:expired', onExpired)

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            if (session) setShow(false)
        })

        return () => {
            window.removeEventListener('auth:expired', onExpired)
            subscription.unsubscribe()
        }
    }, [])

    if (!show) return null

    return (
        <div
            role="alert"
            style={{
                position: 'fixed', top: 56, left: 0, right: 0, zIndex: 900,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, flexWrap: 'wrap',
                padding: '9px 16px',
                background: 'rgba(244,114,182,0.12)',
                borderBottom: '1px solid rgba(244,114,182,0.4)',
                backdropFilter: 'blur(8px)',
            }}
        >
            <span style={{ fontSize: '0.8rem', color: '#f472b6', fontWeight: 700 }}>
                Your session expired — please sign in again.
            </span>
            <button
                onClick={() => { setShow(false); navigate('/auth') }}
                style={{
                    padding: '4px 14px', borderRadius: 6, border: '1px solid rgba(244,114,182,0.5)',
                    background: 'none', color: '#f472b6', cursor: 'pointer',
                    fontSize: '0.72rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.06em',
                }}
            >
                Sign in
            </button>
            <button
                onClick={() => setShow(false)}
                aria-label="Dismiss"
                style={{
                    background: 'none', border: 'none', color: '#71717a', cursor: 'pointer',
                    fontSize: '1rem', lineHeight: 1, padding: '0 4px',
                }}
            >
                ×
            </button>
        </div>
    )
}

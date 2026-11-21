import { useCallback, useEffect, useMemo, useState } from 'react'
import { dismissToast, subscribeToasts, toast } from '../../lib/toast'

// ── ToastProvider / useToast ───────────────────────────────────────
// Renders the shared toast stack (bottom-right; full width on phones).
// Two live regions so screen readers hear errors assertively and
// success/info politely. Toasts auto-dismiss (paused while hovered or
// focused) and close with the x button or Escape.
export function useToast() {
    return toast
}

const ICON = { success: '✓', error: '!', info: 'i' }

function ToastItem({ t }) {
    const [paused, setPaused] = useState(false)
    const close = useCallback(() => dismissToast(t.id), [t.id])

    useEffect(() => {
        if (paused || !t.duration) return undefined
        const timer = setTimeout(close, t.duration)
        return () => clearTimeout(timer)
        // t.bump restarts the timer when an identical toast is raised again
    }, [paused, t.duration, t.bump, close])

    return (
        <div
            className={`toast toast-${t.type}`}
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            onFocus={() => setPaused(true)}
            onBlur={() => setPaused(false)}
            onKeyDown={(e) => { if (e.key === 'Escape') close() }}
        >
            <span className="toast-icon" aria-hidden="true">{ICON[t.type] || 'i'}</span>
            <span className="toast-msg">{t.message}</span>
            {t.action && (
                <button type="button" className="toast-action" onClick={() => { t.action.onClick?.(); close() }}>
                    {t.action.label}
                </button>
            )}
            <button type="button" className="toast-close" aria-label="Dismiss notification" onClick={close}>×</button>
        </div>
    )
}

export function ToastProvider({ children }) {
    const [list, setList] = useState([])
    useEffect(() => subscribeToasts(setList), [])
    const errors = useMemo(() => list.filter((t) => t.type === 'error'), [list])
    const others = useMemo(() => list.filter((t) => t.type !== 'error'), [list])

    return (
        <>
            {children}
            <div className="toast-stack">
                <div role="status" aria-live="polite" className="toast-region">
                    {others.map((t) => <ToastItem key={t.id} t={t} />)}
                </div>
                <div role="alert" aria-live="assertive" className="toast-region">
                    {errors.map((t) => <ToastItem key={t.id} t={t} />)}
                </div>
            </div>
        </>
    )
}

export default ToastProvider

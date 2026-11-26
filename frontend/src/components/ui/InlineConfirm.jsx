import { useEffect, useRef } from 'react'

/**
 * Inline confirmation strip; use instead of window.confirm. Focuses the cancel button on mount (safe default).
 *
 *   {confirming && (
 *       <InlineConfirm message="Remove this subscription?" confirmLabel="Remove"
 *           onConfirm={remove} onCancel={() => setConfirming(false)} busy={removing} />
 *   )}
 *
 * tone: 'danger' (default, red strip + danger button) | 'neutral' (cyan strip + primary button)
 */
export default function InlineConfirm({ message, confirmLabel = 'Confirm', cancelLabel = 'Keep it', onConfirm, onCancel, busy = false, tone = 'danger', className = '' }) {
    const cancelRef = useRef(null)
    useEffect(() => { cancelRef.current?.focus() }, [])
    const danger = tone === 'danger'
    return (
        <div className={`sys-confirm${danger ? '' : ' is-neutral'} ${className}`.trim()} role="alertdialog" aria-live="assertive" aria-label={message}
            onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onCancel?.() }}>
            <p>{message}</p>
            <button type="button" className={`sys-btn ${danger ? 'is-danger' : 'is-primary'}`} onClick={onConfirm} disabled={busy} aria-busy={busy || undefined}>
                {busy ? 'Working…' : confirmLabel}
            </button>
            <button ref={cancelRef} type="button" className="sys-btn" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
        </div>
    )
}

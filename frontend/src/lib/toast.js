// ── toast store ─────────────────────────────────────────────────────
// Tiny module-level store so toast() is callable from anywhere: components
// (via useToast), react-query's MutationCache, or plain helpers. The
// <ToastProvider> (components/shared/Toaster.jsx) subscribes and renders.
let nextId = 1
let toasts = []
const listeners = new Set()

const DURATION = { success: 3200, info: 4000, error: 6000 }
const MAX_VISIBLE = 4

function emit() {
    for (const l of listeners) l(toasts)
}

export function subscribeToasts(fn) {
    listeners.add(fn)
    fn(toasts)
    return () => listeners.delete(fn)
}

export function dismissToast(id) {
    const before = toasts.length
    toasts = toasts.filter((t) => t.id !== id)
    if (toasts.length !== before) emit()
}

function push(type, message, opts = {}) {
    const text = typeof message === 'string' ? message.trim() : message
    if (!text) return null
    // Collapse an identical toast already on screen (double click, burst of
    // failing requests) instead of stacking copies; restarts its timer.
    const dup = toasts.find((t) => t.type === type && t.message === text)
    if (dup) {
        toasts = toasts.map((t) => (t === dup ? { ...t, bump: (t.bump || 0) + 1 } : t))
        emit()
        return dup.id
    }
    const id = nextId++
    const duration = opts.duration ?? DURATION[type] ?? 4000
    toasts = [...toasts, { id, type, message: text, duration, action: opts.action || null, bump: 0 }].slice(-MAX_VISIBLE)
    emit()
    return id
}

export const toast = Object.assign((message, opts) => push(opts?.type || 'info', message, opts), {
    success: (m, o) => push('success', m, o),
    error: (m, o) => push('error', m, o),
    info: (m, o) => push('info', m, o),
    dismiss: dismissToast,
})

export default toast

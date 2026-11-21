import { MutationCache } from '@tanstack/react-query'
import { toast } from './toast'
import { errorText } from './errorText'

// Global mutation feedback, so no button click ends in silence:
//   • onError   → error toast with errorText(err), unless meta.silent
//                 (callers that render the error inline set it).
//                 meta.error (string | fn(err, vars)) prefixes the message.
//   • onSuccess → success toast with meta.success when set (string, or
//                 fn(data, vars) returning a string).
// Per-hook and per-call useMutation callbacks still run as usual.
export function createMutationCache() {
    return new MutationCache({
        onError: (err, variables, _ctx, mutation) => {
            const meta = mutation?.options?.meta || {}
            // inlineError: the caller renders the error next to the control
            if (meta.silent || meta.inlineError) return
            const prefix = typeof meta.error === 'function' ? meta.error(err, variables) : meta.error
            const msg = errorText(err)
            toast.error(prefix ? `${prefix}: ${msg}` : msg)
        },
        onSuccess: (data, variables, _ctx, mutation) => {
            const meta = mutation?.options?.meta || {}
            if (meta.silent || !meta.success) return
            const msg = typeof meta.success === 'function' ? meta.success(data, variables) : meta.success
            if (msg) toast.success(msg)
        },
    })
}

import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from '../../lib/toast'

/**
 * Copy-to-clipboard button with "Copied" / "Copy failed" feedback (clipboard API rejects on insecure
 * origins, denied permission or an unfocused document; a toast then explains).
 *
 *   <CopyButton text={shareUrl} label="Copy link" />
 *   <CopyButton text={code} className="sys-btn is-primary" />
 */
export default function CopyButton({ text, label = 'Copy', className = 'sys-btn' }) {
    const [state, setState] = useState('idle') // 'idle' | 'done' | 'error'
    useEffect(() => {
        if (state === 'idle') return undefined
        const t = setTimeout(() => setState('idle'), state === 'error' ? 3000 : 1600)
        return () => clearTimeout(t)
    }, [state])
    async function copy() {
        try {
            await navigator.clipboard.writeText(text || '')
            setState('done')
        } catch {
            setState('error')
            toast.error('Could not copy. Select the text and copy it manually.')
        }
    }
    const done = state === 'done'
    return (
        <button type="button" className={`${className}${state === 'error' ? ' is-danger' : ''}`} onClick={copy} disabled={!text}
            aria-label={`${label}${done ? ' (copied)' : state === 'error' ? ' (copy failed)' : ''}`}>
            {done ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
            <span aria-live="polite">{done ? 'Copied' : state === 'error' ? 'Copy failed' : label}</span>
        </button>
    )
}

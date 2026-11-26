import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Body scroll lock shared by every open sheet (nested sheets keep the lock).
let locks = 0
let savedOverflow = ''
function lockScroll() {
    if (locks++ === 0) {
        savedOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
    }
}
function unlockScroll() {
    if (--locks <= 0) {
        locks = 0
        document.body.style.overflow = savedOverflow
    }
}

/**
 * Bottom sheet on phones (full width, slides up), centred dialog from 768px.
 * Focus is trapped inside and returns to the opener on close. Closes on Esc,
 * the close button, a backdrop tap, or a swipe down on the grab handle.
 * Motion is skipped under prefers-reduced-motion. Renders nothing when closed.
 *
 *   const [open, setOpen] = useState(false)
 *   <Sheet open={open} onClose={() => setOpen(false)} title="Filters" footer={<Button block …>Show 120 jobs</Button>}>…</Sheet>
 *
 * title: required (visible heading + aria-labelledby)
 * description: optional one line under the title
 * footer: optional node pinned to the bottom (primary action)
 * size: 'auto' (default, up to 85vh) | 'full' (phones: full height)
 * initialFocus: ref of the element to focus first (default: the sheet itself)
 * dismissible: false hides the close button and ignores Esc / backdrop (use rarely)
 */
export default function Sheet({
    open, onClose, title, description, children, footer, size = 'auto', initialFocus, dismissible = true,
    className = '', ...rest
}) {
    const panelRef = useRef(null)
    const titleId = useId()
    const descId = useId()
    const drag = useRef(null)
    const closeRef = useRef(onClose)
    closeRef.current = onClose

    useEffect(() => {
        if (!open) return undefined
        const opener = document.activeElement
        lockScroll()
        const t = setTimeout(() => {
            const el = initialFocus?.current || panelRef.current
            try { el?.focus({ preventScroll: true }) } catch { /* detached */ }
        }, 0)
        return () => {
            clearTimeout(t)
            unlockScroll()
            try { opener?.focus?.({ preventScroll: true }) } catch { /* gone */ }
        }
    }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

    if (!open || typeof document === 'undefined') return null

    const close = () => { if (dismissible) closeRef.current?.() }

    function onKeyDown(e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(); return }
        if (e.key !== 'Tab' || !panelRef.current) return
        const items = [...panelRef.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)
        if (!items.length) { e.preventDefault(); return }
        const first = items[0]
        const last = items[items.length - 1]
        const a = document.activeElement
        if (e.shiftKey && (a === first || a === panelRef.current)) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus() }
    }

    // Swipe down on the handle / header to dismiss (touch + pen + mouse).
    const onPointerDown = (e) => {
        if (!dismissible || e.button > 0) return
        drag.current = { y: e.clientY, dy: 0 }
        e.currentTarget.setPointerCapture?.(e.pointerId)
    }
    const onPointerMove = (e) => {
        if (!drag.current || !panelRef.current) return
        const dy = Math.max(0, e.clientY - drag.current.y)
        drag.current.dy = dy
        panelRef.current.style.transform = dy ? `translateY(${dy}px)` : ''
    }
    const onPointerUp = () => {
        if (!drag.current || !panelRef.current) return
        const { dy } = drag.current
        drag.current = null
        panelRef.current.style.transform = ''
        if (dy > 80) close()
    }
    const dragProps = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp }

    return createPortal(
        <div className="sys-sheet-root" onKeyDown={onKeyDown}>
            <div className="sys-sheet-backdrop" onClick={close} aria-hidden="true" />
            <div
                ref={panelRef}
                className={`sys-sheet${size === 'full' ? ' is-full' : ''} ${className}`.trim()}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={description ? descId : undefined}
                tabIndex={-1}
                {...rest}
            >
                <div className="sys-sheet-head" {...dragProps}>
                    <span className="sys-sheet-handle" aria-hidden="true" />
                    <div className="sys-sheet-titles">
                        <h2 id={titleId} className="sys-sheet-title">{title}</h2>
                        {description && <p id={descId} className="sys-sheet-desc">{description}</p>}
                    </div>
                    {dismissible && (
                        <button type="button" className="sys-sheet-close" onClick={close} aria-label="Close" onPointerDown={(e) => e.stopPropagation()}>
                            <X size={20} aria-hidden="true" />
                        </button>
                    )}
                </div>
                <div className="sys-sheet-body">{children}</div>
                {footer && <div className="sys-sheet-foot">{footer}</div>}
            </div>
        </div>,
        document.body,
    )
}

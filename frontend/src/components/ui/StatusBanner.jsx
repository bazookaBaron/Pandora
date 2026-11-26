import { isValidElement } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'

const TONES = {
    info: { cls: 'is-info', Icon: Info },
    ok: { cls: 'is-ok', Icon: CircleCheck },
    warn: { cls: 'is-warn', Icon: TriangleAlert },
    action: { cls: 'is-action', Icon: CircleAlert },
}

/**
 * The ONE status line at the top of a page (plan §2 "status first"). Keep the
 * text to one short sentence; put the next step in `action`.
 *
 *   <StatusBanner tone="action" text="3 questions need your answer" action={{ label: 'Answer now', to: '/autoapply/needs-you' }} />
 *   <StatusBanner tone="ok" text="Payment received. We start applying today." onDismiss={hide} />
 *
 * tone: 'info' (cyan) | 'ok' (green) | 'warn' (amber) | 'action' (pink, needs the user)
 * text: string or node · action: { label, to? | href? | onClick? } or a node
 * onDismiss: shows a close button when set
 */
export default function StatusBanner({ tone = 'info', text, children, action, onDismiss, className = '', ...rest }) {
    const t = TONES[tone] || TONES.info
    const Icon = t.Icon
    return (
        <div className={`sys-banner ${t.cls} ${className}`.trim()} role="status" {...rest}>
            <Icon className="sys-banner-icon" size={18} aria-hidden="true" />
            <p className="sys-banner-text">{text ?? children}</p>
            {action && <span className="sys-banner-act">{renderAction(action)}</span>}
            {onDismiss && (
                <button type="button" className="sys-banner-x" onClick={onDismiss} aria-label="Dismiss">
                    <X size={16} aria-hidden="true" />
                </button>
            )}
        </div>
    )
}

function renderAction(action) {
    if (isValidElement(action) || typeof action !== 'object') return action
    const { label, to, href, onClick, ...rest } = action
    const inner = <><span>{label}</span><ArrowRight size={15} aria-hidden="true" /></>
    if (to) return <Link to={to} className="sys-banner-btn" onClick={onClick} {...rest}>{inner}</Link>
    if (href) return <a href={href} className="sys-banner-btn" onClick={onClick} {...rest}>{inner}</a>
    return <button type="button" className="sys-banner-btn" onClick={onClick} {...rest}>{inner}</button>
}

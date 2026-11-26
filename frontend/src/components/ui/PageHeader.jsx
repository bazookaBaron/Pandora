import { isValidElement } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import { getSection } from '../../lib/sections'

/**
 * Top of every page (plan §2): section colour strip, title (20/600), one-line
 * subtitle (13px muted, ellipsis), optional ONE primary action in the section
 * tone (full width on phones), optional back link.
 *
 *   <PageHeader section="autoapply" title="Your packs" subtitle="18 of 50 applied so far"
 *               action={{ label: 'See packs', to: '/autoapply/buy' }} back={{ to: '/autoapply', label: 'Auto Apply' }} />
 *
 * section: 'jobs' | 'prepare' | 'autoapply' | 'referrals' | 'me' (tone + default title)
 * title / subtitle: strings (subtitle <= 60 chars, one line). Omitted -> the section's default; null -> none
 * action: { label, to? | href? | onClick?, icon?, disabled?, busy? } or any React node
 * back:   { to, label? } | '/path'
 * aside:  small node right of the title (e.g. <HelpChip term="pack" />)
 * children: rendered under the header row (e.g. a StatusBanner); keep it short
 */
export default function PageHeader({ section = 'jobs', title, subtitle, action, back, aside, children, className = '', titleId, ...rest }) {
    const s = getSection(section)
    const sub = subtitle === undefined ? s.subtitle : subtitle
    const backObj = typeof back === 'string' ? { to: back } : back
    return (
        <header className={`sys-ph ${className}`.trim()} style={{ '--tone': s.tone, '--tone-dim': s.toneDim }} data-section={s.id} {...rest}>
            {backObj?.to && (
                <Link to={backObj.to} className="sys-ph-back">
                    <ChevronLeft size={18} aria-hidden="true" />
                    <span>{backObj.label || 'Back'}</span>
                </Link>
            )}
            <div className="sys-ph-row">
                <div className="sys-ph-text">
                    <div className="sys-ph-titleline">
                        <h1 className="sys-ph-title" id={titleId}>{title || s.title}</h1>
                        {aside}
                    </div>
                    {sub && <p className="sys-ph-sub">{sub}</p>}
                </div>
                {action && <div className="sys-ph-action">{renderAction(action)}</div>}
            </div>
            {children}
        </header>
    )
}

function renderAction(action) {
    if (isValidElement(action) || typeof action !== 'object') return action
    const { label, to, href, onClick, icon: Icon, disabled, busy, ...rest } = action
    const content = (
        <>
            {busy ? <span className="sys-spin" aria-hidden="true" /> : Icon && <Icon size={16} aria-hidden="true" />}
            <span>{label}</span>
        </>
    )
    if (to) return <Link to={to} className="sys-tone-btn" onClick={onClick} aria-disabled={disabled || undefined} {...rest}>{content}</Link>
    if (href) return <a href={href} className="sys-tone-btn" onClick={onClick} aria-disabled={disabled || undefined} {...rest}>{content}</a>
    return (
        <button type="button" className="sys-tone-btn" onClick={onClick} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
            {content}
        </button>
    )
}

export { renderAction as renderToneAction }

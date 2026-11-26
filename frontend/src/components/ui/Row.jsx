import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'

/**
 * One-line list row (min-height 56px): leading slot · title (ellipsis) · optional
 * sub line · meta chip · trailing slot. Put rows in <ul className="sys-rows"> (<li> each)
 * or any container.
 *
 *   <Row leading={<CompanyLogo name={c} />} title="SDE 2" sub="Razorpay · Bengaluru" meta="2h" to={`/jobs/${id}`} />
 *   <Row title="Inbox" meta="3 new" metaTone="attention" onClick={open} />
 *   <Row leading={<FluidCheckbox … />} title="Two Sum" trailing={<Button …>Solve</Button>} to="/dsa/…" />
 *
 * Clickable when `to` (router Link), `href` (<a>) or `onClick` (<button>) is set.
 * trailing: chevron by default when clickable; pass a node (e.g. an action button) or
 *   `chevron={false}`. When `trailing` is an interactive node AND the row is clickable,
 *   only the leading + title area is the link, so controls are never nested.
 * meta: short text or node shown as a chip; metaTone: a .tone-* suffix (active, success,
 *   attention, waiting, history, danger, plan).
 * tone: CSS colour for the 3px left edge (e.g. 'var(--pop)'), optional.
 */
export default function Row({
    leading, title, sub, meta, metaTone, trailing, chevron = true, to, href, onClick, target, rel,
    tone, selected = false, disabled = false, className = '', 'aria-label': ariaLabel, ...rest
}) {
    const clickable = !disabled && !!(to || href || onClick)
    const style = tone ? { '--row-tone': tone } : undefined
    const cls = ['sys-lrow', clickable && 'is-link', selected && 'is-on', disabled && 'is-disabled', tone && 'has-tone', className].filter(Boolean).join(' ')
    const chip = meta != null && meta !== '' && (
        typeof meta === 'string' || typeof meta === 'number'
            ? <span className={'sys-lrow-meta' + (metaTone ? ` tone-${metaTone} is-toned` : '')}>{meta}</span>
            : meta
    )
    const main = (
        <>
            {leading && <span className="sys-lrow-lead">{leading}</span>}
            <span className="sys-lrow-text">
                <span className="sys-lrow-title">{title}</span>
                {sub && <span className="sys-lrow-sub">{sub}</span>}
            </span>
            {chip}
        </>
    )
    const chevronNode = clickable && chevron && trailing === undefined
        ? <ChevronRight className="sys-lrow-chev" size={18} aria-hidden="true" />
        : null

    const hitProps = { 'aria-label': ariaLabel, 'aria-current': selected ? 'true' : undefined }
    const renderHit = (cn, children) => {
        if (to) return <Link to={to} className={cn} onClick={onClick} {...hitProps}>{children}</Link>
        if (href) return <a href={href} target={target} rel={rel || (target === '_blank' ? 'noopener noreferrer' : undefined)} className={cn} onClick={onClick} {...hitProps}>{children}</a>
        return <button type="button" className={cn} onClick={onClick} {...hitProps}>{children}</button>
    }

    // Interactive trailing node + clickable row: split so controls are not nested.
    if (clickable && trailing != null) {
        return (
            <div className={cls + ' is-split'} style={style} {...rest}>
                {renderHit('sys-lrow-hit', main)}
                <span className="sys-lrow-trail">{trailing}</span>
            </div>
        )
    }
    if (clickable) {
        return (
            <div className={cls + ' is-split'} style={style} {...rest}>
                {renderHit('sys-lrow-hit', <>{main}{chevronNode}</>)}
            </div>
        )
    }
    return (
        <div className={cls} style={style} aria-disabled={disabled || undefined} {...rest}>
            <span className="sys-lrow-hit">{main}</span>
            {trailing != null && <span className="sys-lrow-trail">{trailing}</span>}
        </div>
    )
}

import { Link } from 'react-router-dom'

/**
 * Small button in the shared system (.sys-btn). Renders <Link> with `to`, <a> with `href`, else <button type="button">.
 *
 *   <Button variant="primary" icon={Plus} onClick={add}>Add</Button>
 *   <Button variant="danger" busy={saving} busyLabel="Removing…">Remove</Button>
 *   <Button variant="upgrade" to="/pricing" size="lg">Upgrade to Pro</Button>
 *   <Button variant="ghost" icon={X} iconOnly aria-label="Close" />
 *
 * variant: secondary (default) | primary | danger | warm | ghost | upgrade
 * size: sm (default) | lg      block: full width      iconOnly: square icon button (needs aria-label)
 * busy: disables + shows a spinner and `busyLabel` (default: children)
 * Everything else (aria-*, data-*, type, disabled, title, …) is passed through.
 */
export default function Button({
    variant = 'secondary', size = 'sm', block = false, iconOnly = false, icon: Icon, iconRight: IconRight,
    busy = false, busyLabel, to, href, className = '', children, disabled, type = 'button', ...rest
}) {
    const cls = [
        'sys-btn',
        variant !== 'secondary' && `is-${variant}`,
        size === 'lg' && 'is-lg',
        block && 'is-block',
        iconOnly && 'sys-icon-btn',
        className,
    ].filter(Boolean).join(' ')
    const iconSize = size === 'lg' ? 15 : 13
    const content = (
        <>
            {busy ? <span className="sys-spin" aria-hidden="true" /> : Icon && <Icon size={iconSize} aria-hidden="true" />}
            {busy && busyLabel ? busyLabel : children}
            {!busy && IconRight && <IconRight size={iconSize} aria-hidden="true" />}
        </>
    )
    if (to) {
        return <Link to={to} className={cls} aria-disabled={disabled || undefined} {...rest}>{content}</Link>
    }
    if (href) {
        return <a href={href} className={cls} aria-disabled={disabled || undefined} {...rest}>{content}</a>
    }
    return (
        // eslint-disable-next-line react/button-has-type
        <button type={type} className={cls} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
            {content}
        </button>
    )
}

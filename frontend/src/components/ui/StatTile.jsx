import { Link } from 'react-router-dom'
import { num } from '../../lib/format'

/**
 * Key-number tile: label + icon on top, big value (tinted by `tone` once > 0), optional `total` and hint.
 * Renders a <Link> when `to` is set, a <button> when `onClick` is set, else a <div>.
 *
 *   <StatTile icon={CheckCircle2} label="Solved" value={42} total={300} hint="14%" tone="success" to="/dsa" />
 */
export function StatTile({ icon: Icon, label, value, total, hint, tone = 'history', to, onClick, className = '' }) {
    const has = Number(value) > 0
    const shown = value == null ? '—' : (typeof value === 'number' ? num(value) : value)
    const body = (
        <>
            <span className="sys-tile-top">
                <span className="sys-tile-label">{label}</span>
                {Icon && <Icon size={16} className="sys-tile-icon" aria-hidden="true" />}
            </span>
            <span className="sys-tile-value">
                {shown}
                {total != null && <span className="sys-tile-total">/ {typeof total === 'number' ? num(total) : total}</span>}
            </span>
            {hint && <span className="sys-tile-hint">{hint}</span>}
        </>
    )
    const cls = `sys-tile tone-${tone}${has ? ' has-value' : ''} ${className}`.trim()
    if (to) return <Link to={to} className={cls}>{body}</Link>
    if (onClick) return <button type="button" className={cls} onClick={onClick}>{body}</button>
    return <div className={cls}>{body}</div>
}

/**
 * Grid wrapper for StatTile. `cols` = desktop columns (default 4). Phones get 2 columns,
 * except cols={3}, which stays 3-up.
 *
 *   <StatTiles cols={3}><StatTile … /><StatTile … /><StatTile … /></StatTiles>
 */
export function StatTiles({ cols = 4, children, className = '', style, ...rest }) {
    return (
        <div className={`sys-tiles${cols === 3 ? ' is-3' : ''} ${className}`.trim()} style={{ '--sys-tile-cols': cols, ...style }} {...rest}>
            {children}
        </div>
    )
}

export default StatTile

// Shared page layout primitives (styles live in index.css under "Shared layout").
//   <PageContainer>  – centered column that clears the fixed nav
//   <PageHeader>     – title + one-line subtitle + optional right-aligned actions
//   <Section>        – optional small heading above a bordered Card; 24px gap between sections
//   <Card>           – bordered surface with consistent padding
//   <FilterBar>      – one bordered bar that groups search / filters / sort
//   <Menu>           – small dropdown for secondary actions (children are <MenuItem>)

import { useEffect, useRef, useState } from 'react'

export function PageContainer({ children, width = 'md', as: Tag = 'main', className = '', ...rest }) {
    return (
        <Tag className={`wrap pg-container pg-${width} ${className}`.trim()} {...rest}>
            {children}
        </Tag>
    )
}

export function PageHeader({ title, subtitle, actions, back }) {
    return (
        <header className="pg-header">
            <div className="pg-header-text">
                {back}
                <h1 className="pg-title">{title}</h1>
                {subtitle && <p className="pg-subtitle">{subtitle}</p>}
            </div>
            {actions && <div className="pg-actions">{actions}</div>}
        </header>
    )
}

export function Card({ children, flush = false, className = '', as: Tag = 'div', ...rest }) {
    return <Tag className={`pg-card${flush ? ' is-flush' : ''} ${className}`.trim()} {...rest}>{children}</Tag>
}

export function Section({ title, hint, actions, children, flush = false, card = true, className = '', ...rest }) {
    return (
        <section className={`pg-section ${className}`.trim()} {...rest}>
            {(title || actions) && (
                <div className="pg-section-head">
                    <div>
                        {title && <h2 className="pg-section-title">{title}</h2>}
                        {hint && <p className="pg-section-hint">{hint}</p>}
                    </div>
                    {actions && <div className="pg-actions">{actions}</div>}
                </div>
            )}
            {card ? <Card flush={flush}>{children}</Card> : children}
        </section>
    )
}

export function FilterBar({ children, className = '', ...rest }) {
    return <div className={`pg-filterbar ${className}`.trim()} {...rest}>{children}</div>
}

export function StatChip({ label, value, total }) {
    return (
        <div className="pg-stat">
            <span className="pg-stat-label">{label}</span>
            <span className="pg-stat-value">{value}</span>
            {total != null && <><span className="pg-stat-sep">/</span><span className="pg-stat-total">{total}</span></>}
        </div>
    )
}

// Dropdown for secondary actions. `label` is the trigger text; items close the menu on click.
export function Menu({ label = 'More', children, align = 'right', disabled = false, className = 'aa-btn' }) {
    const [open, setOpen] = useState(false)
    const ref = useRef(null)
    useEffect(() => {
        if (!open) return undefined
        const onPointer = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onPointer)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onPointer)
            document.removeEventListener('keydown', onKey)
        }
    }, [open])
    return (
        <div className="menu" ref={ref}>
            <button type="button" className={className} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((v) => !v)}>
                {label}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            {open && (
                <div className="menu-list" role="menu" style={align === 'left' ? { left: 0, right: 'auto' } : undefined} onClick={() => setOpen(false)}>
                    {children}
                </div>
            )}
        </div>
    )
}

export function MenuItem({ children, danger = false, ...rest }) {
    return <button type="button" role="menuitem" className={`menu-item${danger ? ' is-danger' : ''}`} {...rest}>{children}</button>
}

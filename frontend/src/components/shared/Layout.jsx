// Shared page layout primitives (styles live in index.css under "Shared layout").
//   <PageContainer>  – centered column that clears the fixed nav
//   <PageHeader>     – title + one-line subtitle + optional right-aligned actions
//   <Section>        – optional small heading above a bordered Card; 24px gap between sections
//   <Card>           – bordered surface with consistent padding
//   <FilterBar>      – one bordered bar that groups search / filters / sort

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

import { Link } from 'react-router-dom'

const LINKS = [
    ['/pricing', 'Pricing'],
    ['/terms', 'Terms'],
    ['/privacy', 'Privacy'],
    ['/refunds', 'Refunds'],
    ['/contact', 'Contact'],
]

export default function Footer() {
    return (
        <footer style={{
            borderTop: '1px solid var(--subtle)',
            background: 'var(--surface)',
            padding: '20px 16px 28px',
            marginTop: 40,
        }}>
            <div style={{
                maxWidth: 980, margin: '0 auto',
                display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14,
                fontSize: '0.75rem', color: 'var(--muted)',
            }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 800, color: 'var(--accent)' }}>
                    <img src="/vloombox-logo.svg" alt="" width="16" height="16" style={{ display: 'block' }} />
                    Vloombox
                </span>
                <nav style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                    {LINKS.map(([to, label]) => (
                        <Link key={to} to={to} style={{ color: 'var(--muted)', textDecoration: 'none' }}>{label}</Link>
                    ))}
                </nav>
                <span style={{ marginLeft: 'auto', color: 'var(--faint)' }}>
                    © {new Date().getFullYear()} Vloombox
                </span>
            </div>
        </footer>
    )
}

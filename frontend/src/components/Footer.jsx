import { Link } from 'react-router-dom'
import { useMediaQuery } from '../lib/useMediaQuery'

// TODO: replace with the real company social profile URLs.
const SOCIAL = {
    linkedin: 'https://www.linkedin.com/', // TODO: real LinkedIn page URL
    twitter: 'https://x.com/',             // TODO: real Twitter/X profile URL
}

const COLUMNS = [
    {
        title: 'Company',
        links: [
            ['About Us', '/about'],
            ['Contact Us', '/contact'],
        ],
    },
    {
        title: 'Product',
        links: [
            ['Blog', '/blog'],
            ['Question Bank', '/interview'], // the existing Interview Questions page
            ['Referral Marketplace', '/referrals'],
        ],
    },
    {
        title: 'Legal',
        links: [
            ['Privacy Policy', '/legal/privacy'],
            ['Terms of Service', '/legal/terms'],
            ['Community Guidelines', '/legal/guidelines'],
        ],
    },
]

// lucide-react in this project (v1.37.0) ships no brand icons, so LinkedIn / X
// use inline brand marks — consistent with the app's inline-SVG convention.
function LinkedInIcon(props) {
    return (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
            <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.55V9h3.57v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z" />
        </svg>
    )
}
function XIcon(props) {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
            <path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.66l-5.22-6.82-5.97 6.82H1.55l7.73-8.83L1.12 2.25h6.83l4.71 6.23 5.58-6.23zm-1.16 17.52h1.83L7.02 4.13H5.06l12.02 15.64z" />
        </svg>
    )
}

const linkStyle = {
    color: 'var(--muted)',
    textDecoration: 'none',
    fontSize: '0.78rem',
    lineHeight: 1.9,
    transition: 'color var(--transition)',
}

export default function Footer() {
    const isMobile = useMediaQuery('(max-width: 767px)')
    return (
        <footer
            style={{
                borderTop: '1px solid var(--subtle)',
                background: 'var(--surface)',
                color: 'var(--muted)',
                padding: '32px 16px 28px',
                marginTop: 48,
            }}
        >
            <div
                style={{
                    maxWidth: 1120,
                    margin: '0 auto',
                    display: 'grid',
                    gap: 28,
                    gridTemplateColumns: isMobile ? '1fr' : 'repeat(4, minmax(0, 1fr))',
                }}
            >
                {/* Brand */}
                <div style={{ gridColumn: '1 / -1', marginBottom: 4 }}>
                    <Link
                        to="/"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 900, color: 'var(--bright)', textDecoration: 'none', letterSpacing: '-0.01em' }}
                    >
                        <img src="/vloombox-logo.svg" alt="" width="28" height="28" style={{ display: 'block' }} />
                        Vloombox
                    </Link>
                </div>

                {COLUMNS.map((col) => (
                    <nav key={col.title} aria-label={col.title}>
                        <h3
                            style={{
                                fontSize: '0.66rem', fontWeight: 900, textTransform: 'uppercase',
                                letterSpacing: '0.1em', color: 'var(--accent)', margin: '0 0 8px',
                            }}
                        >
                            {col.title}
                        </h3>
                        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                            {col.links.map(([label, to]) => (
                                <li key={to}>
                                    <Link
                                        to={to}
                                        style={linkStyle}
                                        onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--bright)')}
                                        onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted)')}
                                    >
                                        {label}
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    </nav>
                ))}

                {/* Support */}
                <nav aria-label="Support">
                    <h3
                        style={{
                            fontSize: '0.66rem', fontWeight: 900, textTransform: 'uppercase',
                            letterSpacing: '0.1em', color: 'var(--accent)', margin: '0 0 8px',
                        }}
                    >
                        Support
                    </h3>
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                        <li>
                            <Link
                                to="/faq"
                                style={linkStyle}
                                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--bright)')}
                                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted)')}
                            >
                                FAQ
                            </Link>
                        </li>
                    </ul>
                    <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                        <a
                            href={SOCIAL.linkedin}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="Vloombox on LinkedIn"
                            style={{
                                display: 'grid', placeItems: 'center', width: 30, height: 30,
                                borderRadius: 6, border: '1px solid var(--subtle)', color: 'var(--muted)',
                                transition: 'color var(--transition), border-color var(--transition)',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--pop)'; e.currentTarget.style.borderColor = 'var(--subtle-strong)' }}
                            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--muted)'; e.currentTarget.style.borderColor = 'var(--subtle)' }}
                        >
                            <LinkedInIcon />
                        </a>
                        <a
                            href={SOCIAL.twitter}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="Vloombox on X (Twitter)"
                            style={{
                                display: 'grid', placeItems: 'center', width: 30, height: 30,
                                borderRadius: 6, border: '1px solid var(--subtle)', color: 'var(--muted)',
                                transition: 'color var(--transition), border-color var(--transition)',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--pop)'; e.currentTarget.style.borderColor = 'var(--subtle-strong)' }}
                            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--muted)'; e.currentTarget.style.borderColor = 'var(--subtle)' }}
                        >
                            <XIcon />
                        </a>
                    </div>
                </nav>
            </div>

            <div
                style={{
                    maxWidth: 1120, margin: '24px auto 0', paddingTop: 16,
                    borderTop: '1px solid var(--subtle)', fontSize: '0.72rem', color: 'var(--faint)',
                }}
            >
                {/* TODO: confirm the legal entity name for the copyright line. */}
                © {new Date().getFullYear()} Vloombox. All rights reserved.
            </div>
        </footer>
    )
}

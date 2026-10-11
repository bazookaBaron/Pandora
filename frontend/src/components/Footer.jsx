import { Link } from 'react-router-dom'
import { useMediaQuery } from '../lib/useMediaQuery'
import { VLOOMBOX_BLURB } from '../lib/brand'

const SOCIAL = {
    youtube: 'https://www.youtube.com/@Vloomboxin',
    instagram: 'https://www.instagram.com/vloombox/',
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
            ['Hiring Trends', '/trends'],
            ['Job Market Analytics', '/jobs/analytics'],
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

// lucide-react in this project (v1.37.0) ships no brand icons, so YouTube /
// Instagram use inline brand marks — consistent with the app's inline-SVG convention.
function YouTubeIcon(props) {
    return (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
            <path d="M23.5 6.2a3.02 3.02 0 0 0-2.12-2.14C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.38.56A3.02 3.02 0 0 0 .5 6.2 31.6 31.6 0 0 0 0 12a31.6 31.6 0 0 0 .5 5.8 3.02 3.02 0 0 0 2.12 2.14C4.5 20.5 12 20.5 12 20.5s7.5 0 9.38-.56A3.02 3.02 0 0 0 23.5 17.8 31.6 31.6 0 0 0 24 12a31.6 31.6 0 0 0-.5-5.8zM9.75 15.02V8.98L15.5 12l-5.75 3.02z" />
        </svg>
    )
}
function InstagramIcon(props) {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
            <path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.43.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.43.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.72 3.72 0 0 1-1.38-.9 3.72 3.72 0 0 1-.9-1.38c-.16-.43-.36-1.06-.41-2.23-.06-1.27-.07-1.65-.07-4.85s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.43-.16 1.06-.36 2.23-.41 1.27-.06 1.65-.07 4.85-.07M12 0C8.74 0 8.33.01 7.05.07c-1.28.06-2.15.26-2.91.56a5.87 5.87 0 0 0-2.13 1.38A5.87 5.87 0 0 0 .63 4.14c-.3.76-.5 1.63-.56 2.91C.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.06 1.28.26 2.15.56 2.91.3.76.72 1.42 1.38 2.13.7.66 1.37 1.08 2.13 1.38.76.3 1.63.5 2.91.56C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c1.28-.06 2.15-.26 2.91-.56a5.87 5.87 0 0 0 2.13-1.38 5.87 5.87 0 0 0 1.38-2.13c.3-.76.5-1.63.56-2.91.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95c-.06-1.28-.26-2.15-.56-2.91a5.87 5.87 0 0 0-1.38-2.13A5.87 5.87 0 0 0 19.86.63c-.76-.3-1.63-.5-2.91-.56C15.67.01 15.26 0 12 0zm0 5.84A6.16 6.16 0 1 0 18.16 12 6.16 6.16 0 0 0 12 5.84zm0 10.16A4 4 0 1 1 16 12a4 4 0 0 1-4 4zm6.41-10.85a1.44 1.44 0 1 1-1.44-1.44 1.44 1.44 0 0 1 1.44 1.44z" />
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
                <div style={{ gridColumn: '1 / -1', marginBottom: 4, maxWidth: 520 }}>
                    <Link
                        to="/"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 900, color: 'var(--bright)', textDecoration: 'none', letterSpacing: '-0.01em' }}
                    >
                        <img src="/vloombox-logo.svg" alt="" width="28" height="28" style={{ display: 'block' }} />
                        Vloombox
                    </Link>
                    <p style={{ margin: '8px 0 0', fontSize: '0.75rem', lineHeight: 1.6, color: 'var(--muted)' }}>
                        {VLOOMBOX_BLURB}
                    </p>
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
                            href={SOCIAL.youtube}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="Vloombox on YouTube"
                            style={{
                                display: 'grid', placeItems: 'center', width: 30, height: 30,
                                borderRadius: 6, border: '1px solid var(--subtle)', color: 'var(--muted)',
                                transition: 'color var(--transition), border-color var(--transition)',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--pop)'; e.currentTarget.style.borderColor = 'var(--subtle-strong)' }}
                            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--muted)'; e.currentTarget.style.borderColor = 'var(--subtle)' }}
                        >
                            <YouTubeIcon />
                        </a>
                        <a
                            href={SOCIAL.instagram}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="Vloombox on Instagram"
                            style={{
                                display: 'grid', placeItems: 'center', width: 30, height: 30,
                                borderRadius: 6, border: '1px solid var(--subtle)', color: 'var(--muted)',
                                transition: 'color var(--transition), border-color var(--transition)',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--pop)'; e.currentTarget.style.borderColor = 'var(--subtle-strong)' }}
                            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--muted)'; e.currentTarget.style.borderColor = 'var(--subtle)' }}
                        >
                            <InstagramIcon />
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

import { useState } from 'react'
import { COMPANY_DOMAIN_MAP } from '../../lib/companyDomains'

/**
 * Single company logo chip.
 * Uses Google's high-quality favicon CDN (no CORS issues).
 * Falls back to styled text chip if domain is unknown or image fails.
 */
export default function CompanyLogo({ company, style }) {
    const domain = COMPANY_DOMAIN_MAP[company]
    const [imgErr, setImgErr] = useState(false)

    const baseStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: domain && !imgErr ? '2px 6px 2px 4px' : '1px 6px',
        borderRadius: 4,
        background: '#27272a',
        border: '1px solid #3f3f46',
        fontSize: '0.62rem',
        color: '#a1a1aa',
        whiteSpace: 'nowrap',
        cursor: 'default',
        textDecoration: 'none',
        lineHeight: 1.4,
        ...style,
    }

    if (domain && !imgErr) {
        // Google Favicon CDN — no CORS, high quality, free
        const src = `https://www.google.com/s2/favicons?sz=32&domain_url=${domain}`
        return (
            <span style={baseStyle} title={company}>
                <img
                    src={src}
                    alt=""
                    width={14}
                    height={14}
                    style={{ borderRadius: 2, display: 'block', flexShrink: 0 }}
                    onError={() => setImgErr(true)}
                />
                {company}
            </span>
        )
    }

    // Fallback: plain text chip
    return (
        <span style={baseStyle} title={company}>
            {company}
        </span>
    )
}

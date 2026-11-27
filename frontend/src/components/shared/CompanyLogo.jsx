import { useState } from 'react'
import { logoSources } from '../../lib/companyLogo'

/**
 * Single company logo chip.
 * Source order: explicit logo -> Google favicon of `domain` -> favicon of the static
 * domain map (name/slug, case-insensitive). Each failing image advances to the next;
 * falls back to the styled text chip when none load.
 */
export default function CompanyLogo({ company, style, logo, domain: domainProp, slug }) {
    const sources = logoSources({ logo, domain: domainProp, name: company, slug, size: 32 })
    const key = sources.join('|')
    const [fail, setFail] = useState({ key, n: 0 })
    const idx = fail.key === key ? fail.n : 0
    const src = idx < sources.length ? sources[idx] : null

    const baseStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: src ? '2px 6px 2px 4px' : '1px 6px',
        borderRadius: 4,
        background: 'var(--subtle)',
        border: '1px solid var(--subtle-strong)',
        fontSize: '0.62rem',
        color: 'var(--accent)',
        whiteSpace: 'nowrap',
        cursor: 'default',
        textDecoration: 'none',
        lineHeight: 1.4,
        ...style,
    }

    if (src) {
        return (
            <span style={baseStyle} title={company}>
                <img
                    src={src}
                    alt=""
                    width={14}
                    height={14}
                    style={{ borderRadius: 2, display: 'block', flexShrink: 0 }}
                    onError={() => setFail({ key, n: idx + 1 })}
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

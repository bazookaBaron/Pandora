import { useParams, Link } from 'react-router-dom'
import Navbar from '../../components/Navbar'
import DSAListPage from './DSAListPage'

// Thin wrapper: renders the shared DSA list pre-filtered to one company. The
// list itself now goes through the authenticated /api/catalog/dsa endpoint
// (tier caps enforced server-side), so there's no separate catalog fetch here —
// the old numeric company breakdown was dropped to avoid a second query that
// would also have leaked locked rows on the free tier.
export default function DSACompanyPage() {
    const { companyName } = useParams()
    const decoded = decodeURIComponent(companyName)

    return (
        <>
            <Navbar />
            <div className="has-tilebar" style={{ paddingTop: 56 }}>
                {/* Company header */}
                <div style={{ borderBottom: '1px solid var(--subtle)', background: 'var(--surface-2)' }}>
                    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 16px' }}>
                        <Link to="/dsa" style={{ fontSize: '0.72rem', color: 'var(--muted)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 12 }}>
                            ← All Problems
                        </Link>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                            <div style={{
                                width: 48, height: 48, borderRadius: 10, background: 'var(--panel)',
                                border: '2px solid var(--subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: '1.2rem', fontWeight: 900, color: '#22d3ee', flexShrink: 0,
                            }}>
                                {decoded.charAt(0).toUpperCase()}
                            </div>
                            <div>
                                <h1 style={{ fontSize: '1.3rem', fontWeight: 900, letterSpacing: '-0.03em', color: 'var(--bright)' }}>{decoded}</h1>
                                <p style={{ color: 'var(--muted)', fontSize: '0.78rem', marginTop: 2 }}>Problems tagged with {decoded}</p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Reuse DSAListPage with company pre-filtered */}
                <DSAListPage filterCompany={decoded} />
            </div>
        </>
    )
}

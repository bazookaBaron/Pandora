import { useParams, Link } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
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
                    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '16px' }}>
                        <Link to="/dsa" className="pr-crumb" style={{ marginBottom: 12 }}>
                            <ChevronLeft size={14} aria-hidden="true" /> All problems
                        </Link>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{
                                width: 40, height: 40, borderRadius: 10, background: 'var(--panel)',
                                border: '1px solid var(--subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: '1.2rem', fontWeight: 900, color: 'var(--pop)', flexShrink: 0,
                            }}>
                                {decoded.charAt(0).toUpperCase()}
                            </div>
                            <div style={{ minWidth: 0 }}>
                                <h1 className="pg-title">{decoded}</h1>
                                <p className="pg-subtitle">Problems tagged with {decoded}</p>
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

import { useParams } from 'react-router-dom'
import DSAListPage from './DSAListPage'

// Thin wrapper: renders the shared DSA list pre-filtered to one company. The
// list renders its own Navbar + company header (logo, name, progress) and the
// "open jobs at <Company>" bridge at the end. The list goes through the
// authenticated /api/catalog/dsa endpoint (tier caps enforced server-side).
export default function DSACompanyPage() {
    const { companyName } = useParams()
    let decoded = companyName
    try { decoded = decodeURIComponent(companyName) } catch { /* keep the raw slug */ }
    return <DSAListPage filterCompany={decoded} />
}

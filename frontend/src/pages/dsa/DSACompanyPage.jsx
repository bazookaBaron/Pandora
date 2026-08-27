import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import Navbar from '../../components/Navbar'
import DSAListPage from './DSAListPage'

function DifficultyBar({ problems }) {
    const counts = { Easy: 0, Medium: 0, Hard: 0 }
    problems.forEach(p => { if (counts[p.difficulty] !== undefined) counts[p.difficulty]++ })
    const total = problems.length || 1
    return (
        <div style={{ display: 'flex', gap: 4, height: 8, borderRadius: 6, overflow: 'hidden', width: 200 }}>
            <div style={{ flex: counts.Easy / total, background: '#4ade80', minWidth: counts.Easy ? 2 : 0 }} title={`Easy: ${counts.Easy}`} />
            <div style={{ flex: counts.Medium / total, background: '#facc15', minWidth: counts.Medium ? 2 : 0 }} title={`Medium: ${counts.Medium}`} />
            <div style={{ flex: counts.Hard / total, background: '#f87171', minWidth: counts.Hard ? 2 : 0 }} title={`Hard: ${counts.Hard}`} />
        </div>
    )
}

export default function DSACompanyPage() {
    const { companyName } = useParams()
    const decoded = decodeURIComponent(companyName)

    const { data: problems = [], isLoading } = useQuery({
        queryKey: ['dsa-company', decoded],
        queryFn: async () => {
            const { data, error } = await supabase
                .from('leetcode_company_problems')
                .select('id, title, difficulty, link, company, frequency, acceptance_rate, topics')
                .contains('company', [decoded])
            if (error) throw error
            return data || []
        },
        staleTime: 5 * 60 * 1000,
    })

    const easyCt = problems.filter(p => p.difficulty === 'Easy').length
    const medCt = problems.filter(p => p.difficulty === 'Medium').length
    const hardCt = problems.filter(p => p.difficulty === 'Hard').length

    return (
        <>
            <Navbar />
            <div style={{ paddingTop: 56 }}>
                {/* Company header */}
                <div style={{ borderBottom: '1px solid #27272a', background: '#0d0d0f' }}>
                    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 16px' }}>
                        <Link to="/dsa" style={{ fontSize: '0.72rem', color: '#71717a', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 12 }}>
                            ← All Problems
                        </Link>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                            {/* Company initial avatar */}
                            <div style={{
                                width: 48, height: 48, borderRadius: 10, background: '#18181b',
                                border: '2px solid #27272a', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: '1.2rem', fontWeight: 900, color: '#22d3ee', flexShrink: 0,
                            }}>
                                {decoded.charAt(0).toUpperCase()}
                            </div>
                            <div>
                                <h1 style={{ fontSize: '1.3rem', fontWeight: 900, letterSpacing: '-0.03em', color: '#fafafa' }}>{decoded}</h1>
                                <p style={{ color: '#71717a', fontSize: '0.78rem', marginTop: 2 }}>
                                    {isLoading ? '…' : `${problems.length} problems`}
                                </p>
                            </div>
                            {!isLoading && problems.length > 0 && (
                                <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    <DifficultyBar problems={problems} />
                                    <div style={{ display: 'flex', gap: 12, fontSize: '0.68rem' }}>
                                        <span style={{ color: '#4ade80' }}>Easy {easyCt}</span>
                                        <span style={{ color: '#facc15' }}>Med {medCt}</span>
                                        <span style={{ color: '#f87171' }}>Hard {hardCt}</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Reuse DSAListPage with company pre-filtered */}
                <DSAListPage filterCompany={decoded} />
            </div>
        </>
    )
}

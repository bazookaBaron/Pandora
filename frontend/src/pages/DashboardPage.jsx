import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import Navbar from '../components/Navbar'

export default function DashboardPage() {
    const { user } = useAuth()

    const { data: readiness = [], isLoading } = useQuery({
        queryKey: ['company-readiness', user?.id],
        queryFn: async () => {
            if (!user) return []
            const { data, error } = await supabase.rpc('get_company_readiness', { p_user_id: user.id })
            if (error) throw error
            return data || []
        },
        enabled: !!user,
        staleTime: 0,
        refetchOnMount: 'always',
        refetchOnWindowFocus: true,
    })

    const { data: progressRows = [] } = useQuery({
        queryKey: ['all-progress', user?.id],
        queryFn: async () => {
            if (!user) return []
            const { data } = await supabase
                .from('user_problem_progress')
                .select('problem_type, status')
                .eq('user_id', user.id)
            return data || []
        },
        enabled: !!user,
        staleTime: 0,
        refetchOnMount: 'always',
        refetchOnWindowFocus: true,
    })

    const dsaSolved = progressRows.filter(r => r.problem_type === 'dsa' && r.status === 'solved').length
    const lldSolved = progressRows.filter(r => r.problem_type === 'lld' && r.status === 'solved').length

    // Group readiness by company, merge LLD + DSA rows
    const companyMap = {}
    readiness.forEach(r => {
        if (!companyMap[r.company_name]) companyMap[r.company_name] = { dsa: null, lld: null }
        companyMap[r.company_name][r.problem_type] = r
    })

    // Sort by total solved desc
    const companies = Object.entries(companyMap).sort(([, a], [, b]) => {
        const aTotal = (a.dsa?.solved ?? 0) + (a.lld?.solved ?? 0)
        const bTotal = (b.dsa?.solved ?? 0) + (b.lld?.solved ?? 0)
        return bTotal - aTotal
    })

    return (
        <>
            <Navbar />
            <div style={{ paddingTop: 56, minHeight: '100vh', maxWidth: 1100, margin: '0 auto', padding: '80px 16px 60px' }}>
                <div style={{ marginBottom: 28 }}>
                    <h1 style={{ fontSize: '1.2rem', fontWeight: 900, letterSpacing: '-0.03em', color: '#fafafa' }}>Dashboard</h1>
                    <p style={{ color: '#71717a', fontSize: '0.78rem', marginTop: 2 }}>Your interview prep readiness at a glance</p>
                </div>

                {/* Overall stats */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 32 }}>
                    {[
                        { label: 'DSA Solved', value: dsaSolved, color: '#22d3ee', link: '/dsa?status=solved' },
                        { label: 'LLD Practiced', value: lldSolved, color: '#f472b6', link: '/lld' },
                        { label: 'Companies', value: companies.length, color: '#a78bfa', link: null },
                    ].map(stat => (
                        <div key={stat.label} style={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 10, padding: '16px 20px' }}>
                            <div style={{ fontSize: '1.8rem', fontWeight: 900, color: stat.color }}>{stat.value}</div>
                            <div style={{ fontSize: '0.68rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#71717a', marginTop: 4 }}>{stat.label}</div>
                            {stat.link && (
                                <Link to={stat.link} style={{ fontSize: '0.68rem', color: stat.color, textDecoration: 'none', marginTop: 6, display: 'block', opacity: 0.7 }}>View →</Link>
                            )}
                        </div>
                    ))}
                </div>

                {/* Company readiness */}
                <h2 style={{ fontSize: '0.9rem', fontWeight: 900, color: '#fafafa', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 14, borderBottom: '1px solid #27272a', paddingBottom: 8 }}>
                    Company Readiness
                </h2>

                {isLoading ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
                        {Array.from({ length: 9 }).map((_, i) => (
                            <div key={i} style={{ height: 88, background: '#18181b', borderRadius: 8, animation: 'pulse 1.5s ease-in-out infinite' }} />
                        ))}
                    </div>
                ) : companies.length === 0 ? (
                    <div style={{ padding: '40px 0', textAlign: 'center', color: '#71717a', fontSize: '0.88rem' }}>
                        <div style={{ fontSize: '2rem', marginBottom: 8 }}>📊</div>
                        No readiness data yet. Start solving problems to see your progress here!
                    </div>
                ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                        {companies.map(([name, data]) => {
                            const dsaTotal = data.dsa?.total ?? 0, dsaSolvedCt = data.dsa?.solved ?? 0
                            const lldTotal = data.lld?.total ?? 0, lldSolvedCt = data.lld?.solved ?? 0
                            const dsaPct = dsaTotal ? Math.round((dsaSolvedCt / dsaTotal) * 100) : 0
                            const lldPct = lldTotal ? Math.round((lldSolvedCt / lldTotal) * 100) : 0
                            const overallPct = (dsaTotal + lldTotal) ? Math.round(((dsaSolvedCt + lldSolvedCt) / (dsaTotal + lldTotal)) * 100) : 0

                            return (
                                <div key={name} style={{
                                    background: '#18181b', border: '1px solid #27272a', borderRadius: 8, padding: '14px 16px',
                                    transition: 'border-color 0.15s, transform 0.15s',
                                }}
                                    onMouseEnter={e => { e.currentTarget.style.borderColor = '#3f3f46'; e.currentTarget.style.transform = 'translateY(-2px)' }}
                                    onMouseLeave={e => { e.currentTarget.style.borderColor = '#27272a'; e.currentTarget.style.transform = 'none' }}
                                >
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                                        <span style={{ fontWeight: 900, fontSize: '0.88rem', color: '#fafafa' }}>{name}</span>
                                        <span style={{ fontSize: '0.72rem', fontWeight: 900, color: overallPct > 50 ? '#4ade80' : overallPct > 25 ? '#facc15' : '#71717a' }}>
                                            {overallPct}%
                                        </span>
                                    </div>

                                    {dsaTotal > 0 && (
                                        <div style={{ marginBottom: 6 }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                                                <Link to={`/dsa/company/${encodeURIComponent(name)}`} style={{ fontSize: '0.65rem', color: '#22d3ee', textDecoration: 'none', fontWeight: 700, textTransform: 'uppercase' }}>DSA</Link>
                                                <span style={{ fontSize: '0.65rem', color: '#71717a' }}>{dsaSolvedCt}/{dsaTotal}</span>
                                            </div>
                                            <div style={{ height: 4, background: '#27272a', borderRadius: 2, overflow: 'hidden' }}>
                                                <div style={{ width: `${dsaPct}%`, height: '100%', background: '#22d3ee', borderRadius: 2, transition: 'width 0.5s' }} />
                                            </div>
                                        </div>
                                    )}

                                    {lldTotal > 0 && (
                                        <div>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                                                <Link to={`/lld?company=${encodeURIComponent(name)}`} style={{ fontSize: '0.65rem', color: '#f472b6', textDecoration: 'none', fontWeight: 700, textTransform: 'uppercase' }}>LLD</Link>
                                                <span style={{ fontSize: '0.65rem', color: '#71717a' }}>{lldSolvedCt}/{lldTotal}</span>
                                            </div>
                                            <div style={{ height: 4, background: '#27272a', borderRadius: 2, overflow: 'hidden' }}>
                                                <div style={{ width: `${lldPct}%`, height: '100%', background: '#f472b6', borderRadius: 2, transition: 'width 0.5s' }} />
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                )}
            </div>
        </>
    )
}

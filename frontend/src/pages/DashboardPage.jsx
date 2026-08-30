import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import Navbar from '../components/Navbar'

// SVG ring progress component
function RingProgress({ pct, color, size = 80, stroke = 8 }) {
    const r = (size - stroke) / 2
    const circ = 2 * Math.PI * r
    const dash = circ * Math.min(1, pct / 100)
    const bg = color + '22'
    return (
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={bg} strokeWidth={stroke} />
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
                strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
                style={{ transition: 'stroke-dasharray 0.8s cubic-bezier(.4,0,.2,1)' }} />
        </svg>
    )
}

function StatCard({ label, value, color, link }) {
    return (
        <div style={{ background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '16px 20px' }}>
            <div style={{ fontSize: '1.8rem', fontWeight: 900, color }}>{value}</div>
            <div style={{ fontSize: '0.68rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginTop: 4 }}>{label}</div>
            {link && <Link to={link} style={{ fontSize: '0.68rem', color, textDecoration: 'none', marginTop: 6, display: 'block', opacity: 0.7 }}>View →</Link>}
        </div>
    )
}

export default function DashboardPage() {
    const { user } = useAuth()

    // All user progress
    const { data: progressRows = [] } = useQuery({
        queryKey: ['all-progress', user?.id],
        queryFn: async () => {
            if (!user) return []
            const { data } = await supabase
                .from('user_problem_progress')
                .select('problem_type, status, is_bookmarked, updated_at, problem_id')
                .eq('user_id', user.id)
                .order('updated_at', { ascending: false })
            return data || []
        },
        enabled: !!user, staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: true,
    })

    // Problem totals
    const { data: totals = { dsa: 0, lld: 0, hld: 0 } } = useQuery({
        queryKey: ['problem-totals'],
        queryFn: async () => {
            const [{ count: dsa }, { count: lld }, { count: hld }] = await Promise.all([
                supabase.from('leetcode_company_problems').select('*', { count: 'exact', head: true }),
                supabase.from('lld_problems').select('*', { count: 'exact', head: true }),
                supabase.from('hld_questions').select('*', { count: 'exact', head: true }),
            ])
            return { dsa: dsa || 0, lld: lld || 0, hld: hld || 0 }
        },
        staleTime: 10 * 60 * 1000,
    })

    // DSA problems for weak topics
    const { data: dsaProblems = [] } = useQuery({
        queryKey: ['dsa-problems-dash'],
        queryFn: async () => {
            const { data } = await supabase
                .from('leetcode_company_problems')
                .select('id, topics, difficulty')
            return data || []
        },
        staleTime: 10 * 60 * 1000,
    })

    // Company readiness (for focus companies)
    const { data: readiness = [], isLoading: readinessLoading } = useQuery({
        queryKey: ['company-readiness', user?.id],
        queryFn: async () => {
            if (!user) return []
            const { data, error } = await supabase.rpc('get_company_readiness', { p_user_id: user.id })
            if (error) return []
            return data || []
        },
        enabled: !!user, staleTime: 0, refetchOnMount: 'always',
    })

    // Computed stats
    const dsaSolved = progressRows.filter(r => r.problem_type === 'dsa' && r.status === 'solved').length
    const lldSolved = progressRows.filter(r => r.problem_type === 'lld' && r.status === 'solved').length
    const hldAttempted = progressRows.filter(r => r.problem_type === 'hld' && ['attempted', 'solved'].includes(r.status)).length

    const dsaPct = totals.dsa ? Math.round((dsaSolved / totals.dsa) * 100) : 0
    const lldPct = totals.lld ? Math.round((lldSolved / totals.lld) * 100) : 0
    const hldPct = totals.hld ? Math.round((hldAttempted / totals.hld) * 100) : 0

    // Difficulty breakdown for DSA
    const difficulties = ['Easy', 'Medium', 'Hard']
    const diffColors = { Easy: '#4ade80', Medium: '#facc15', Hard: '#f87171' }
    const solvedIds = new Set(progressRows.filter(r => r.problem_type === 'dsa' && r.status === 'solved').map(r => r.problem_id))
    const diffBreakdown = difficulties.map(d => {
        const total = dsaProblems.filter(p => p.difficulty === d).length
        const done = dsaProblems.filter(p => p.difficulty === d && solvedIds.has(p.id)).length
        return { d, total, done }
    })

    // Recent activity (last 5 from progress rows already sorted by updated_at desc)
    const recentActivity = progressRows.filter(r => r.status !== 'unsolved').slice(0, 5)

    // Focus companies: only those with any progress or bookmarks
    const companyMap = {}
    readiness.forEach(r => {
        if (!companyMap[r.company_name]) companyMap[r.company_name] = { dsa: null, lld: null }
        companyMap[r.company_name][r.problem_type] = r
    })
    const focusCompanies = Object.entries(companyMap)
        .filter(([, d]) => (d.dsa?.solved ?? 0) + (d.lld?.solved ?? 0) > 0)
        .sort(([, a], [, b]) => ((b.dsa?.solved ?? 0) + (b.lld?.solved ?? 0)) - ((a.dsa?.solved ?? 0) + (a.lld?.solved ?? 0)))
        .slice(0, 12)

    // Weak topics: topics with lowest solve rate
    const topicStats = {}
    dsaProblems.forEach(p => {
        (p.topics || '').split(',').forEach(t => {
            const topic = t.trim()
            if (!topic) return
            if (!topicStats[topic]) topicStats[topic] = { total: 0, solved: 0 }
            topicStats[topic].total++
            if (solvedIds.has(p.id)) topicStats[topic].solved++
        })
    })
    const weakTopics = Object.entries(topicStats)
        .filter(([, s]) => s.total >= 5 && s.solved > 0)
        .sort(([, a], [, b]) => (a.solved / a.total) - (b.solved / b.total))
        .slice(0, 5)

    const modules = [
        { label: 'DSA', pct: dsaPct, color: '#22d3ee', solved: dsaSolved, total: totals.dsa, link: '/dsa' },
        { label: 'LLD', pct: lldPct, color: '#f472b6', solved: lldSolved, total: totals.lld, link: '/lld' },
        { label: 'HLD', pct: hldPct, color: '#a78bfa', solved: hldAttempted, total: totals.hld, link: '/hld' },
    ]

    const companiesStarted = focusCompanies.length

    return (
        <>
            <Navbar />
            <div style={{ paddingTop: 56, minHeight: '100vh', maxWidth: 1100, margin: '0 auto', padding: '80px 16px 60px' }}>
                <div style={{ marginBottom: 28 }}>
                    <h1 style={{ fontSize: '1.2rem', fontWeight: 900, letterSpacing: '-0.03em', color: 'var(--bright)' }}>Dashboard</h1>
                    <p style={{ color: 'var(--muted)', fontSize: '0.78rem', marginTop: 2 }}>Your interview prep at a glance</p>
                </div>

                {/* Stat cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 28 }}>
                    <StatCard label="DSA Solved" value={dsaSolved} color="#22d3ee" link="/dsa?status=solved" />
                    <StatCard label="LLD Practiced" value={lldSolved} color="#f472b6" link="/lld" />
                    <StatCard label="HLD Attempted" value={hldAttempted} color="#a78bfa" link="/hld" />
                    <StatCard label="Companies Started" value={companiesStarted} color="#fb923c" />
                </div>

                {/* Progress rings */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 28 }}>
                    {modules.map(m => (
                        <div key={m.label} style={{ background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '20px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                            <div style={{ position: 'relative' }}>
                                <RingProgress pct={m.pct} color={m.color} size={80} stroke={7} />
                                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
                                    <span style={{ fontSize: '1rem', fontWeight: 900, color: m.color }}>{m.pct}%</span>
                                </div>
                            </div>
                            <div style={{ textAlign: 'center' }}>
                                <div style={{ fontWeight: 900, fontSize: '0.82rem', color: 'var(--bright)' }}>{m.label}</div>
                                <div style={{ fontSize: '0.68rem', color: 'var(--muted)', marginTop: 2 }}>{m.solved} / {m.total}</div>
                            </div>
                            <Link to={m.link} style={{ fontSize: '0.68rem', color: m.color, textDecoration: 'none', opacity: 0.8 }}>Open →</Link>
                        </div>
                    ))}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 28 }}>
                    {/* Difficulty Breakdown */}
                    <div style={{ background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '18px 20px' }}>
                        <h2 style={{ fontSize: '0.78rem', fontWeight: 900, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 14 }}>DSA Difficulty Breakdown</h2>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {diffBreakdown.map(({ d, total, done }) => {
                                const pct = total ? Math.round((done / total) * 100) : 0
                                return (
                                    <div key={d}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                            <span style={{ fontSize: '0.72rem', fontWeight: 700, color: diffColors[d] }}>{d}</span>
                                            <span style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>{done}/{total}</span>
                                        </div>
                                        <div style={{ height: 6, background: 'var(--subtle)', borderRadius: 3, overflow: 'hidden' }}>
                                            <div style={{ width: `${pct}%`, height: '100%', background: diffColors[d], borderRadius: 3, transition: 'width 0.6s ease' }} />
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    </div>

                    {/* Recent Activity */}
                    <div style={{ background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '18px 20px' }}>
                        <h2 style={{ fontSize: '0.78rem', fontWeight: 900, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 14 }}>Recent Activity</h2>
                        {recentActivity.length === 0 ? (
                            <p style={{ color: 'var(--faint)', fontSize: '0.82rem' }}>No activity yet. Start solving!</p>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {recentActivity.map((r, i) => {
                                    const typeColor = r.problem_type === 'dsa' ? '#22d3ee' : r.problem_type === 'lld' ? '#f472b6' : '#a78bfa'
                                    const when = new Date(r.updated_at)
                                    const ago = Math.round((Date.now() - when.getTime()) / 60000)
                                    const agoStr = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`
                                    return (
                                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                            <span style={{ fontSize: '0.6rem', fontWeight: 900, textTransform: 'uppercase', color: typeColor, background: typeColor + '18', border: `1px solid ${typeColor}33`, borderRadius: 4, padding: '1px 5px', flexShrink: 0 }}>{r.problem_type}</span>
                                            <span style={{ fontSize: '0.72rem', color: r.status === 'solved' ? '#4ade80' : '#facc15', fontWeight: 700, textTransform: 'uppercase', flexShrink: 0 }}>{r.status}</span>
                                            <span style={{ fontSize: '0.68rem', color: 'var(--faint)', marginLeft: 'auto', flexShrink: 0 }}>{agoStr}</span>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                </div>

                {/* Weak Topics */}
                {weakTopics.length > 0 && (
                    <div style={{ background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 10, padding: '18px 20px', marginBottom: 28 }}>
                        <h2 style={{ fontSize: '0.78rem', fontWeight: 900, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 14 }}>
                            ⚠️ Weak Topics <span style={{ color: 'var(--faint)', fontWeight: 400, textTransform: 'none' }}>(low solve rate)</span>
                        </h2>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                            {weakTopics.map(([topic, s]) => {
                                const pct = Math.round((s.solved / s.total) * 100)
                                return (
                                    <Link key={topic} to={`/dsa?q=${encodeURIComponent(topic)}`} style={{ textDecoration: 'none' }}>
                                        <div style={{ background: 'var(--subtle)', border: '1px solid var(--subtle-strong)', borderRadius: 6, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <span style={{ fontSize: '0.75rem', color: 'var(--bright)', fontWeight: 700 }}>{topic}</span>
                                            <span style={{ fontSize: '0.65rem', color: '#f87171', fontWeight: 900 }}>{pct}%</span>
                                        </div>
                                    </Link>
                                )
                            })}
                        </div>
                    </div>
                )}

                {/* Focus Companies */}
                <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                        <h2 style={{ fontSize: '0.9rem', fontWeight: 900, color: 'var(--bright)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                            Focus Companies
                        </h2>
                        <span style={{ fontSize: '0.72rem', color: 'var(--faint)' }}>Companies you've started</span>
                    </div>

                    {readinessLoading ? (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                            {Array.from({ length: 6 }).map((_, i) => (
                                <div key={i} style={{ height: 80, background: 'var(--panel)', borderRadius: 8, animation: 'pulse 1.5s ease-in-out infinite' }} />
                            ))}
                        </div>
                    ) : focusCompanies.length === 0 ? (
                        <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--muted)', fontSize: '0.88rem' }}>
                            <div style={{ fontSize: '2rem', marginBottom: 8 }}>🎯</div>
                            Start solving problems to see your focus companies here.
                        </div>
                    ) : (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                            {focusCompanies.map(([name, data]) => {
                                const dsaTotal = data.dsa?.total ?? 0, dsaDone = data.dsa?.solved ?? 0
                                const lldTotal = data.lld?.total ?? 0, lldDone = data.lld?.solved ?? 0
                                const overallPct = (dsaTotal + lldTotal) ? Math.round(((dsaDone + lldDone) / (dsaTotal + lldTotal)) * 100) : 0
                                const pctColor = overallPct > 50 ? '#4ade80' : overallPct > 20 ? '#facc15' : 'var(--muted)'
                                return (
                                    <div key={name} style={{ background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 8, padding: '12px 14px', transition: 'border-color 0.15s' }}
                                        onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--subtle-strong)'}
                                        onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--subtle)'}
                                    >
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                            <span style={{ fontWeight: 900, fontSize: '0.82rem', color: 'var(--bright)' }}>{name}</span>
                                            <span style={{ fontSize: '0.72rem', fontWeight: 900, color: pctColor }}>{overallPct}%</span>
                                        </div>
                                        <div style={{ display: 'flex', gap: 8 }}>
                                            {dsaTotal > 0 && (
                                                <Link to={`/dsa/company/${encodeURIComponent(name)}`} style={{ fontSize: '0.62rem', color: '#22d3ee', textDecoration: 'none', fontWeight: 700 }}>DSA {dsaDone}/{dsaTotal}</Link>
                                            )}
                                            {lldTotal > 0 && (
                                                <Link to={`/lld?company=${encodeURIComponent(name)}`} style={{ fontSize: '0.62rem', color: '#f472b6', textDecoration: 'none', fontWeight: 700 }}>LLD {lldDone}/{lldTotal}</Link>
                                            )}
                                        </div>
                                        <div style={{ marginTop: 8, height: 4, background: 'var(--subtle)', borderRadius: 2, overflow: 'hidden' }}>
                                            <div style={{ width: `${overallPct}%`, height: '100%', background: pctColor, borderRadius: 2, transition: 'width 0.5s' }} />
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </div>
            </div>
        </>
    )
}

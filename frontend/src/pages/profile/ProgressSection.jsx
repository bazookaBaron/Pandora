import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { BarChart3, Code2, Boxes, Network, Building2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { apiFetch } from '../../lib/apiClient'
import { relTime } from '../../lib/format'
import { SectionHead, StatTile, StatTiles, Progress, Pill } from '../../components/ui'
import { DIFFICULTY_TONE } from '../../components/shared/DifficultyBadge'

// One tone per practice module, shared by the tiles and the activity rows.
const TYPE_TONE = { dsa: 'active', lld: 'attention', hld: 'plan' }

export default function ProgressSection({ user }) {
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
        // progress changes only when the user solves something (those pages
        // write through useProgress, which updates this key), so 30 s is fresh
        // enough and avoids a refetch storm on every visit/focus.
        enabled: !!user, staleTime: 30_000, refetchOnWindowFocus: true,
    })

    // All catalog-derived aggregates come pre-computed from the server (service
    // role) — no per-row catalog data is fetched in the browser.
    const { data: overview } = useQuery({
        queryKey: ['stats-overview', user?.id],
        queryFn: () => apiFetch('/api/stats/overview'),
        enabled: !!user,
        staleTime: 5 * 60 * 1000,
    })
    const totals = overview?.totals || { dsa: 0, lld: 0, hld: 0 }
    const readiness = overview?.readiness || []

    const dsaSolved = progressRows.filter(r => r.problem_type === 'dsa' && r.status === 'solved').length
    const lldSolved = progressRows.filter(r => r.problem_type === 'lld' && r.status === 'solved').length
    const hldAttempted = progressRows.filter(r => r.problem_type === 'hld' && ['attempted', 'solved'].includes(r.status)).length
    const pct = (n, t) => (t ? Math.round((n / t) * 100) : 0)

    const diffBreakdown = overview?.difficulty || []
    const recentActivity = progressRows.filter(r => r.status !== 'unsolved').slice(0, 5)

    const companyMap = {}
    readiness.forEach(r => {
        if (!companyMap[r.company_name]) companyMap[r.company_name] = { dsa: null, lld: null }
        companyMap[r.company_name][r.problem_type] = r
    })
    const focusCompanies = Object.values(companyMap)
        .filter((d) => (d.dsa?.solved ?? 0) + (d.lld?.solved ?? 0) > 0)
        .slice(0, 12)

    const weakTopics = (overview?.topics || [])
        .filter(s => s.total >= 5 && s.solved > 0)
        .sort((a, b) => (a.solved / a.total) - (b.solved / b.total))
        .slice(0, 5)

    return (
        <section className="card profile-card" aria-labelledby="pf-progress-h">
            <SectionHead icon={BarChart3} title="Progress" tone="plan" id="pf-progress-h" />

            <StatTiles cols={4}>
                <StatTile icon={Code2} label="DSA" value={dsaSolved} total={totals.dsa} hint={`${pct(dsaSolved, totals.dsa)}% solved`} tone="active" to="/dsa?status=solved" />
                <StatTile icon={Boxes} label="LLD" value={lldSolved} total={totals.lld} hint={`${pct(lldSolved, totals.lld)}% solved`} tone="attention" to="/lld" />
                <StatTile icon={Network} label="HLD" value={hldAttempted} total={totals.hld} hint={`${pct(hldAttempted, totals.hld)}% tried`} tone="plan" to="/hld" />
                <StatTile icon={Building2} label="Companies" value={focusCompanies.length} hint="with solves" tone="success" />
            </StatTiles>

            <div className="profile-pair">
                <div>
                    <h3 className="profile-subhead">DSA difficulty</h3>
                    <div className="profile-stack">
                        {diffBreakdown.map(({ d, total, done }) => (
                            <Progress key={d} value={done} max={total} tone={DIFFICULTY_TONE[d]} thin
                                label={`${d} problems solved`} text={`${d} · ${done}/${total}`} />
                        ))}
                        {diffBreakdown.length === 0 && <p className="profile-empty">No data yet.</p>}
                    </div>
                </div>

                <div>
                    <h3 className="profile-subhead">Recent activity</h3>
                    {recentActivity.length === 0 ? (
                        <p className="profile-empty">No activity yet.</p>
                    ) : (
                        <ul className="sys-list">
                            {recentActivity.map((r, i) => (
                                <li key={i} className={`sys-row tone-${TYPE_TONE[r.problem_type] || 'history'}`}>
                                    <span className="sys-row-main profile-type">{r.problem_type}</span>
                                    <Pill tone={r.status === 'solved' ? 'success' : 'waiting'} soft>{r.status}</Pill>
                                    <span className="sys-row-meta">{relTime(r.updated_at)}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>

            {weakTopics.length > 0 && (
                <div className="profile-weak">
                    <h3 className="profile-subhead">Weak topics</h3>
                    <div className="sys-chips">
                        {weakTopics.map((s) => (
                            <Link key={s.topic} to={`/dsa?q=${encodeURIComponent(s.topic)}`} className="sys-chip is-toned tone-attention profile-chip-link">
                                <span className="sys-chip-text">{s.topic}</span>
                                <strong>{pct(s.solved, s.total)}%</strong>
                            </Link>
                        ))}
                    </div>
                </div>
            )}
        </section>
    )
}

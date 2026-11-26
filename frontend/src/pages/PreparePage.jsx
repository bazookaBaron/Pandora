import { Link } from 'react-router-dom'
import { ChevronRight, Code2, FileText, MessageSquare, Network, Boxes } from 'lucide-react'
import Navbar from '../components/Navbar'
import { PageContainer } from '../components/shared/Layout'
import { PageHeader, NextStep } from '../components/ui'
import { useAuth } from '../contexts/AuthContext'
import { useProgress } from '../lib/useProgress'
import { getSection } from '../lib/sections'
import { TERMS } from '../lib/copy'

// Prepare hub (WS-M0, plan §4.4): one tile per prep tool. Progress lines use the
// progress rows the DSA / LLD / HLD pages already load (shared react-query cache,
// signed-in only); everything else shows a one-line description.
const TILES = [
    { id: 'dsa', to: '/dsa', title: 'DSA', icon: Code2, desc: 'Coding questions by company', progress: 'dsa' },
    { id: 'hld', to: '/hld', title: TERMS.hld.one, icon: Network, desc: 'Design apps like a chat app', progress: 'hld' },
    { id: 'lld', to: '/lld', title: TERMS.lld.one, icon: Boxes, desc: 'Design classes for one feature', progress: 'lld' },
    { id: 'interview', to: '/interview', title: TERMS.interviewQuestions.one, icon: MessageSquare, desc: 'Real questions by topic' },
    { id: 'optimizer', to: '/optimizer', title: TERMS.resumeCheck.one, icon: FileText, desc: 'Tailor your resume to a job' },
]

function solvedCount(map) {
    let n = 0
    for (const r of Object.values(map || {})) if (r?.status === 'solved') n += 1
    return n
}

export default function PreparePage() {
    const { user } = useAuth() || {}
    const dsa = useProgress('dsa')
    const lld = useProgress('lld')
    const hld = useProgress('hld')
    const solved = { dsa: solvedCount(dsa.progressMap), lld: solvedCount(lld.progressMap), hld: solvedCount(hld.progressMap) }
    const tone = getSection('prepare').tone

    return (
        <>
            <Navbar />
            <PageContainer width="sm">
                <PageHeader section="prepare" />
                <ul className="sys-tiles-sec" aria-label="Prepare tools">
                    {TILES.map((t) => {
                        const Icon = t.icon
                        const n = t.progress && user ? solved[t.progress] : 0
                        return (
                            <li key={t.id}>
                                <Link to={t.to} className="sys-sectile" style={{ '--tone': tone }}>
                                    <span className="sys-sectile-icon" aria-hidden="true"><Icon size={22} /></span>
                                    <span className="sys-sectile-text">
                                        <span className="sys-sectile-title">{t.title}</span>
                                        <span className="sys-sectile-sub">{n > 0 ? `${n} solved` : t.desc}</span>
                                    </span>
                                    <ChevronRight className="sys-sectile-chev" size={18} aria-hidden="true" />
                                </Link>
                            </li>
                        )
                    })}
                </ul>
                <NextStep
                    id="prepare-to-jobs"
                    section="jobs"
                    text="Ready to apply? See fresh jobs from top companies."
                    cta={{ label: 'See jobs', to: '/' }}
                />
            </PageContainer>
        </>
    )
}

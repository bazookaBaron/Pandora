import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import Navbar from '../components/Navbar'
import { PageContainer } from '../components/shared/Layout'
import { StatTile, StatTiles, sectionIcon } from '../components/ui'
import { useJobsAnalytics } from '../lib/useJobs'
import { NAV_SECTIONS, getSection } from '../lib/sections'
import { CTA } from '../lib/copy'
import { track, TRACK } from '../lib/track'

// Signed-out marketing landing (plan §4.1): one-line hero + one CTA, proof tiles
// with real numbers only (hidden until the count is known), the section tiles,
// a 4-question FAQ and a final CTA. NOT routed yet: the lead decides where it
// mounts (App.jsx / seoHead.js are shared files). `ctaTo` lets the mount point
// pick the CTA target so a landing served at "/" never links to itself.

const SECTION_BLURB = {
    jobs: 'Fresh jobs, updated daily',
    prepare: 'DSA, design, interview questions',
    autoapply: 'We apply to jobs for you',
    referrals: 'Ask employees directly',
}

const FAQ = [
    ['Is Vloombox free?', 'Yes. Free gives you some of every feature. Pro unlocks more.'],
    ['Where do the jobs come from?', 'Straight from company career pages, checked every day.'],
    ['How do referrals work?', 'You ask. Employees at that company can refer you.'],
    ['Do plans auto-renew?', 'Yes, until you cancel. Cancel anytime and you keep access until the end of the period you paid for.'],
]

const fmt = (n) => Number(n).toLocaleString('en-IN')

export default function LandingPage({ ctaTo = '/' }) {
    const { data } = useJobsAnalytics(true)
    const today = Array.isArray(data?.postedByDay) && data.postedByDay.length
        ? Number(data.postedByDay[data.postedByDay.length - 1]?.count) || 0
        : 0
    const proof = [
        { id: 'open', label: 'Open jobs', value: Number(data?.total) || 0 },
        { id: 'companies', label: 'Companies hiring', value: Number(data?.companiesWithJobs) || 0 },
        { id: 'today', label: 'New today', value: today },
    ].filter((t) => t.value > 0)
    const sections = NAV_SECTIONS.filter((s) => s.id !== 'me')
    const tone = getSection('jobs').tone
    const cta = (id) => () => track(TRACK.CTA_CLICK, { id, section: 'jobs' })

    return (
        <>
            <Navbar />
            <PageContainer width="sm" className="lp">
                <section className="lp-hero" aria-labelledby="lp-title">
                    <h1 id="lp-title" className="lp-title">Get more interviews with less effort</h1>
                    <Link to={ctaTo} className="sys-tone-btn is-block lp-cta" style={{ '--tone': tone }} onClick={cta('landing_hero')}>
                        {CTA.seeJobs}
                    </Link>
                </section>

                {proof.length > 0 && (
                    <StatTiles cols={3} className="lp-proof" aria-label="Vloombox in numbers">
                        {proof.map((t) => <StatTile key={t.id} label={t.label} value={fmt(t.value)} tone="active" />)}
                    </StatTiles>
                )}

                <ul className="sys-tiles-sec" aria-label="What you can do">
                    {sections.map((s) => {
                        const Icon = sectionIcon(s)
                        return (
                            <li key={s.id}>
                                <Link to={s.to} className="sys-sectile" style={{ '--tone': s.tone }}>
                                    <span className="sys-sectile-icon" aria-hidden="true"><Icon size={22} /></span>
                                    <span className="sys-sectile-text">
                                        <span className="sys-sectile-title">{s.name}</span>
                                        <span className="sys-sectile-sub">{SECTION_BLURB[s.id] || s.subtitle}</span>
                                    </span>
                                    <ChevronRight className="sys-sectile-chev" size={18} aria-hidden="true" />
                                </Link>
                            </li>
                        )
                    })}
                </ul>

                <section className="prose lp-faq" aria-labelledby="lp-faq-h">
                    <h2 id="lp-faq-h">Questions</h2>
                    {FAQ.map(([q, a]) => (
                        <details key={q}>
                            <summary>{q}</summary>
                            <p>{a}</p>
                        </details>
                    ))}
                </section>

                <section className="lp-final" aria-label="Get started">
                    <p className="lp-final-text">New jobs land every day.</p>
                    <Link to={ctaTo} className="sys-tone-btn is-block" style={{ '--tone': tone }} onClick={cta('landing_final')}>
                        {CTA.seeJobs}
                    </Link>
                </section>
            </PageContainer>
        </>
    )
}

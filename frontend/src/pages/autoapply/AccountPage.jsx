import { useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AALayout, PageHeader } from './ui'
import SetupSection from './SetupPage'
import SitesSection from './AccountsPage'
import StatsSection from './StatsPage'

const SETUP_STEPS = new Set(['resume', 'answers', 'prefs', 'email', 'consent'])
const SECTIONS = [
    { id: 'profile', label: 'Profile' },
    { id: 'sites', label: 'Job sites' },
    { id: 'stats', label: 'Stats' },
]
const ALIAS = { accounts: 'sites', setup: 'profile' }

// Section comes from the URL hash (#sites, #stats). Setup step ids (#resume, ...) and no hash mean Profile.
function sectionFromHash(hash) {
    const h = (hash || '').replace(/^#/, '')
    if (ALIAS[h]) return ALIAS[h]
    return SECTIONS.some((s) => s.id === h) ? h : 'profile'
}

export default function AccountPage() {
    const { hash, search } = useLocation()
    const navigate = useNavigate()
    // ?section= (survives auth redirects that rewrite the hash) or the hash picks the tab;
    // a pending post-auth password reveal forces Sites so its resume effect runs.
    const section = useMemo(() => {
        let pending = false
        for (const store of ['sessionStorage', 'localStorage']) {
            try { if (window[store].getItem('aa:reveal-after-auth')) pending = true } catch { /* private mode */ }
        }
        if (pending) return 'sites'
        const q = new URLSearchParams(search).get('section')
        if (q && (ALIAS[q] || SECTIONS.some((s) => s.id === q))) return ALIAS[q] || q
        return sectionFromHash(hash)
    }, [hash, search])
    const rawHash = hash.replace(/^#/, '')
    // deep link /autoapply/account#consent -> Profile, that setup step
    const stepFromHash = SETUP_STEPS.has(rawHash) && !new URLSearchParams(search).get('step') ? rawHash : null

    const open = (id) => navigate({ pathname: '/autoapply/account', hash: id === 'profile' ? '' : `#${id}` }, { replace: true })

    return (
        <AALayout gate>
            <PageHeader eyebrow="Account" title="Your account" />
            <div className="aa-tabs" role="tablist" aria-label="Account sections" style={{ marginBottom: 16 }}>
                {SECTIONS.map((s) => (
                    <button key={s.id} type="button" role="tab" aria-selected={section === s.id} className={`aa-tab${section === s.id ? ' is-on' : ''}`} onClick={() => open(s.id)}>
                        {s.label}
                    </button>
                ))}
            </div>
            {section === 'profile' && <SetupSection initialStep={stepFromHash} />}
            {section === 'sites' && <SitesSection />}
            {section === 'stats' && <StatsSection />}
        </AALayout>
    )
}

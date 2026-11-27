import { useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { HelpChip, PageHeader, SmallTabs, TabPanel } from '../../components/ui'
import { TERMS } from '../../lib/copy'
import { AALayout } from './ui'
import SetupSection from './SetupPage'
import SitesSection from './AccountsPage'
import StatsSection from './StatsPage'

// old and new setup step ids (deep links like /autoapply/account#consent open that step)
const SETUP_STEPS = new Set(['role', 'location', 'resume', 'answers', 'review', 'prefs', 'email', 'consent'])
const SECTIONS = [
    { id: 'profile', label: 'Setup', title: 'Your setup', sub: 'Tell us the jobs you want.' },
    { id: 'sites', label: TERMS.portalLogins.plural, title: TERMS.portalLogins.plural, sub: 'Logins we made on job sites.', help: 'portalLogins' },
    { id: 'stats', label: TERMS.results.one, title: TERMS.results.one, sub: 'How your applications are doing.', help: 'results' },
]
const ALIAS = { accounts: 'sites', setup: 'profile' }

// Section comes from the URL hash (#sites, #stats). Setup step ids (#resume, ...) and no hash mean Setup.
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
    const stepFromHash = SETUP_STEPS.has(rawHash) && !new URLSearchParams(search).get('step') ? rawHash : null
    const cur = SECTIONS.find((s) => s.id === section) || SECTIONS[0]

    const open = (id) => navigate({ pathname: '/autoapply/account', hash: id === 'profile' ? '' : `#${id}` }, { replace: true })

    return (
        <AALayout>
            <PageHeader section="autoapply" title={cur.title} subtitle={cur.sub} back={{ to: '/autoapply', label: 'Auto Apply' }}
                aside={cur.help ? <HelpChip term={cur.help} /> : undefined} />
            <SmallTabs idPrefix="aa-acct" label="Account sections" section="autoapply" value={section} onChange={open}
                items={SECTIONS.map((s) => ({ value: s.id, label: s.label }))} style={{ marginBottom: 16 }} />
            <TabPanel idPrefix="aa-acct" value="profile" active={section === 'profile'}><SetupSection initialStep={stepFromHash} /></TabPanel>
            <TabPanel idPrefix="aa-acct" value="sites" active={section === 'sites'}><SitesSection /></TabPanel>
            <TabPanel idPrefix="aa-acct" value="stats" active={section === 'stats'}><StatsSection /></TabPanel>
        </AALayout>
    )
}

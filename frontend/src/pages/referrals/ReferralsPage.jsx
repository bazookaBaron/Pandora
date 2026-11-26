import { useEffect, useState } from 'react'
import { CheckCircle2, Inbox, ListChecks, Send } from 'lucide-react'
import Navbar from '../../components/Navbar'
import { PageContainer, PageHeader } from '../../components/shared/Layout'
import { useAuth } from '../../contexts/AuthContext'
import { useEntitlements } from '../../lib/useEntitlements'
import { LoadingState } from '../../components/shared/states'
import { Button, EmptyArt, Tabs, TabPanel } from '../../components/ui'
import PostTab from './PostTab'
import OpenTab from './OpenTab'
import MineTab from './MineTab'

// ── Page ───────────────────────────────────────────────────────────
const TABS = [
    { value: 'open', label: 'For my company', icon: Inbox },
    { value: 'post', label: 'Post request', icon: Send },
    { value: 'mine', label: 'My requests', icon: ListChecks },
]

// Signed-out visitors can see what the referral board is, but every tab is
// user-specific — so we show one sign-in prompt instead of the tabs.
function SignedOutReferrals() {
    return (
        <div className="sys-card ref-signedout">
            <EmptyArt kind="referrals" tone="active" size={48} />
            <p className="lead">
                Ask members at a company you&rsquo;re targeting to refer you, or refer candidates to yours.
            </p>
            <p className="note">Posting a request is a Pro feature.</p>
            <Button variant="upgrade" size="lg" to="/auth">Sign in</Button>
        </div>
    )
}

export default function ReferralsPage() {
    const { user } = useAuth()
    const { limits, isLoading: entLoading } = useEntitlements()
    const [tab, setTab] = useState('open')
    const [notice, setNotice] = useState('')

    useEffect(() => {
        if (!notice) return
        const t = setTimeout(() => setNotice(''), 8000)
        return () => clearTimeout(t)
    }, [notice])

    const onPosted = () => {
        setNotice('Request posted — matching employees have been notified.')
        setTab('mine')
    }

    return (
        <>
            <Navbar />
            <PageContainer>
                <PageHeader
                    title="Referrals"
                    subtitle="Get referred by verified employees, or refer candidates to your company."
                />

                <div aria-live="polite" style={notice ? undefined : { display: 'contents' }}>
                    {notice && (
                        <p className="sys-note is-ok has-icon" role="status" style={{ margin: 0 }}>
                            <CheckCircle2 size={15} aria-hidden="true" />
                            <span>{notice}</span>
                        </p>
                    )}
                </div>

                {!user ? (
                    <SignedOutReferrals />
                ) : (
                    <>
                        <Tabs
                            idPrefix="ref"
                            label="Referral views"
                            value={tab}
                            onChange={setTab}
                            items={TABS}
                            data-tour="referrals-tabs"
                            style={{ alignSelf: 'flex-start' }}
                        />

                        <div style={{ minWidth: 0 }}>
                            <TabPanel idPrefix="ref" value="open" active={tab === 'open'}><OpenTab /></TabPanel>
                            <TabPanel idPrefix="ref" value="post" active={tab === 'post'}>
                                {entLoading ? <LoadingState /> : <PostTab limits={limits} onPosted={onPosted} />}
                            </TabPanel>
                            <TabPanel idPrefix="ref" value="mine" active={tab === 'mine'}><MineTab /></TabPanel>
                        </div>
                    </>
                )}
            </PageContainer>
        </>
    )
}

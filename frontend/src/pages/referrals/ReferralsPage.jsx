import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Navbar from '../../components/Navbar'
import { PageContainer } from '../../components/shared/Layout'
import { useAuth } from '../../contexts/AuthContext'
import { useEntitlements } from '../../lib/useEntitlements'
import { LoadingState } from '../../components/shared/states'
import { EmptyArt, PageHeader, SmallTabs, StatusBanner, TabPanel } from '../../components/ui'
import { getSection } from '../../lib/sections'
import { CTA } from '../../lib/copy'
import PostTab from './PostTab'
import OpenTab from './OpenTab'
import MineTab from './MineTab'

// Referrals (plan §4.5): "Get referred" · Ask · Give · Mine.
const TABS = [
    { value: 'post', label: 'Ask' },
    { value: 'open', label: 'Give' },
    { value: 'mine', label: 'Mine' },
]
const TONE = getSection('referrals').tone

// Every tab is user-specific, so signed-out visitors get one sign-in prompt.
function SignedOutReferrals() {
    return (
        <div className="rf-empty" style={{ '--tone': TONE }}>
            <EmptyArt kind="referrals" tone="active" size={56} />
            <p className="rf-empty-text">Sign in to ask for referrals</p>
            <Link to="/auth" className="sys-tone-btn">{CTA.signIn}</Link>
        </div>
    )
}

export default function ReferralsPage() {
    const { user } = useAuth()
    const { limits, isLoading: entLoading } = useEntitlements()
    const [tab, setTab] = useState('post')
    const [notice, setNotice] = useState('')

    useEffect(() => {
        if (!notice) return
        const t = setTimeout(() => setNotice(''), 8000)
        return () => clearTimeout(t)
    }, [notice])

    const onPosted = () => {
        setNotice('Request sent. Matching employees were told.')
        setTab('mine')
    }

    return (
        <>
            <Navbar />
            <PageContainer width="sm" className="rf-page">
                <PageHeader section="referrals" />

                <div aria-live="polite" className="rf-live">
                    {notice && <StatusBanner tone="ok" text={notice} onDismiss={() => setNotice('')} />}
                </div>

                {!user ? (
                    <SignedOutReferrals />
                ) : (
                    <>
                        <SmallTabs
                            idPrefix="ref"
                            label="Referrals"
                            section="referrals"
                            value={tab}
                            onChange={setTab}
                            items={TABS}
                            data-tour="referrals-tabs"
                        />

                        <div className="rf-panels">
                            <TabPanel idPrefix="ref" value="post" active={tab === 'post'}>
                                {entLoading ? <LoadingState /> : <PostTab limits={limits} onPosted={onPosted} />}
                            </TabPanel>
                            <TabPanel idPrefix="ref" value="open" active={tab === 'open'}><OpenTab /></TabPanel>
                            <TabPanel idPrefix="ref" value="mine" active={tab === 'mine'}><MineTab onAsk={() => setTab('post')} /></TabPanel>
                        </div>
                    </>
                )}
            </PageContainer>
        </>
    )
}

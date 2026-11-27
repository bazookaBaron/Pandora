import { useState, useEffect } from 'react'
import Navbar from '../../components/Navbar'
import { useInterviewSubcategories } from '../../lib/useInterviewQuestions'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { ssGet, ssSet } from '../../lib/sessionStore'
import SubcategoryList from '../../components/interview/SubcategoryList'
import QuestionList from '../../components/interview/QuestionList'
import AnswerViewer from '../../components/interview/AnswerViewer'
import { toneForSubcategory } from '../../components/interview/categoryTheme'
import { Pill, PageHeader, SmallTabs } from '../../components/ui'
import { TERMS } from '../../lib/copy'

// ── sessionStorage keys ────────────────────────────────────────────
const SK_SUBCATEGORY = 'iq:subcategory'
const SK_QUESTION = 'iq:questionId'
const SK_QUESTION_TEXT = 'iq:questionText'

// ── Main page ─────────────────────────────────────────────────────
// Full-height app layout: calc(100dvh - var(--bnav-h)) so nothing hides
// behind the phone bottom bar. Under 1024px it is one pane at a time,
// switched by small tabs (Topics -> Questions -> Answer).
export default function InterviewPage() {
    const { data: pairs = [], isLoading: subsLoading, error: subsError } = useInterviewSubcategories()
    // Below 1024px the three-column layout gets too cramped to read answers
    // (code / tables / mermaid), so fall back to the tabbed single-pane layout.
    const isMobile = useMediaQuery('(max-width: 1023px)')

    // Restore from sessionStorage; reconciled against real data once loaded.
    const [activeSub, setActiveSub] = useState(() => ssGet(SK_SUBCATEGORY) || null)
    const [activeQId, setActiveQId] = useState(() => ssGet(SK_QUESTION) || null)
    const [activeQText, setActiveQText] = useState(() => ssGet(SK_QUESTION_TEXT) || '')
    const [mobileTab, setMobileTab] = useState('subcategories') // 'subcategories' | 'questions' | 'answer'

    // Active category tone — resolved from the selected subcategory against the
    // loaded (category, subcategory) pairs. Threaded to all three panels.
    const tone = toneForSubcategory(pairs, activeSub)

    // Once subcategories load: if the restored (or empty) subcategory is not a
    // real option, fall back to the first one and drop any stale question.
    const pairsKey = pairs.map(p => p.subcategory).join('|')
    useEffect(() => {
        if (subsLoading || pairs.length === 0) return
        const valid = pairs.some(p => p.subcategory === activeSub)
        if (valid) return
        setActiveSub(pairs[0].subcategory)
        setActiveQId(null)
        setActiveQText('')
        ssSet(SK_SUBCATEGORY, pairs[0].subcategory)
        ssSet(SK_QUESTION, null)
        ssSet(SK_QUESTION_TEXT, null)
    }, [subsLoading, pairsKey, activeSub])

    const handleSubcategorySelect = (sub) => {
        setActiveSub(sub)
        setActiveQId(null)
        setActiveQText('')
        ssSet(SK_SUBCATEGORY, sub)
        ssSet(SK_QUESTION, null)
        ssSet(SK_QUESTION_TEXT, null)
        if (isMobile) setMobileTab('questions')
    }

    const handleQuestionSelect = (id, text) => {
        setActiveQId(id)
        setActiveQText(text)
        ssSet(SK_QUESTION, id)
        ssSet(SK_QUESTION_TEXT, text)
        if (isMobile) setMobileTab('answer')
    }

    const mobileTabs = [
        { value: 'subcategories', label: 'Topics' },
        { value: 'questions', label: 'Questions', disabled: !activeSub },
        { value: 'answer', label: 'Answer', disabled: !activeQId },
    ]

    // ── Panel contents ────────────────────────────────────────────
    const LeftPanel = (
        <div className="iq-pane">
            {!isMobile && (
                <div className="iq-panel-head">
                    <span className="iq-label">Topics</span>
                </div>
            )}
            <SubcategoryList
                pairs={pairs}
                isLoading={subsLoading}
                error={subsError}
                activeSubcategory={activeSub}
                onSelect={handleSubcategorySelect}
            />
        </div>
    )

    const MiddlePanel = (
        <div className="iq-pane">
            {activeQId && !isMobile && (
                <div className="iq-panel-head">
                    <span className="iq-label">Answer</span>
                </div>
            )}
            <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
                <AnswerViewer questionId={activeQId} questionText={activeQText} tone={tone} />
            </div>
        </div>
    )

    const RightPanel = (
        <div className="iq-pane">
            <div className="iq-panel-head">
                <span className="iq-label">Questions</span>
                {activeSub && <Pill tone={tone} soft title={activeSub}>{activeSub}</Pill>}
            </div>
            <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
                <QuestionList subcategory={activeSub} activeId={activeQId} onSelect={handleQuestionSelect} tone={tone} />
            </div>
        </div>
    )

    return (
        <>
            <Navbar />
            <div className="has-tilebar iq-page">
                <div className="iq-top">
                    <PageHeader
                        section="prepare"
                        back={{ to: '/prepare', label: 'Prepare' }}
                        title={TERMS.interviewQuestions.one}
                        subtitle={pairs.length ? `${pairs.length} topics, with answers` : 'Real questions, with answers'}
                    />
                    {isMobile && (
                        <SmallTabs idPrefix="iq" label="Interview panels" section="prepare" value={mobileTab} onChange={setMobileTab} items={mobileTabs} block />
                    )}
                </div>

                {!isMobile ? (
                    <div className="iq-cols">
                        <div className="iq-col is-left">{LeftPanel}</div>
                        <div className="iq-col is-mid">{MiddlePanel}</div>
                        <div className="iq-col is-right">{RightPanel}</div>
                    </div>
                ) : (
                    // Mobile: single pane, tab-controlled
                    <div role="tabpanel" id={`iq-panel-${mobileTab}`} aria-labelledby={`iq-tab-${mobileTab}`} className="iq-mpane">
                        {mobileTab === 'subcategories' && LeftPanel}
                        {mobileTab === 'answer' && MiddlePanel}
                        {mobileTab === 'questions' && RightPanel}
                    </div>
                )}
            </div>
        </>
    )
}

import { useState, useEffect } from 'react'
import Navbar from '../../components/Navbar'
import { useInterviewSubcategories } from '../../lib/useInterviewQuestions'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { ssGet, ssSet } from '../../lib/sessionStore'
import SubcategoryList from '../../components/interview/SubcategoryList'
import QuestionList from '../../components/interview/QuestionList'
import AnswerViewer from '../../components/interview/AnswerViewer'
import { toneForSubcategory } from '../../components/interview/categoryTheme'
import { Tabs, Pill } from '../../components/ui'

const MOBILE_TABS = [
    { value: 'subcategories', label: 'Topics' },
    { value: 'questions', label: 'Questions' },
    { value: 'answer', label: 'Answer' },
]

// ── sessionStorage keys ────────────────────────────────────────────
const SK_SUBCATEGORY = 'iq:subcategory'
const SK_QUESTION = 'iq:questionId'
const SK_QUESTION_TEXT = 'iq:questionText'

// ── Main page ─────────────────────────────────────────────────────
export default function InterviewPage() {
    const { data: pairs = [], isLoading: subsLoading, error: subsError } = useInterviewSubcategories()
    // Below 1024px the three-column layout gets too cramped to read answers
    // (code / tables / mermaid), so fall back to the tabbed single-pane layout.
    const isMobile = useMediaQuery('(max-width: 1023px)')

    // Restore from sessionStorage; reconciled against real data once loaded.
    const [activeSub, setActiveSub] = useState(() => ssGet(SK_SUBCATEGORY) || null)
    const [activeQId, setActiveQId] = useState(() => ssGet(SK_QUESTION) || null)
    const [activeQText, setActiveQText] = useState(() => ssGet(SK_QUESTION_TEXT) || '')
    const [mobileTab, setMobileTab] = useState('subcategories') // 'subcategories' | 'answer' | 'questions'

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

    // ── Panel contents ────────────────────────────────────────────
    const LeftPanel = (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', borderRight: '1px solid var(--subtle)' }}>
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
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', borderRight: '1px solid var(--subtle)' }}>
            {activeQId && !isMobile && (
                <div className="iq-panel-head">
                    <span className="iq-label">Answer</span>
                </div>
            )}
            <div style={{ flex: 1, overflow: 'hidden' }}>
                <AnswerViewer questionId={activeQId} questionText={activeQText} tone={tone} />
            </div>
        </div>
    )

    const RightPanel = (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div className="iq-panel-head">
                <span className="iq-label">Questions</span>
                {activeSub && <Pill tone={tone} soft title={activeSub}>{activeSub}</Pill>}
            </div>
            <div style={{ flex: 1, overflow: 'auto' }}>
                <QuestionList subcategory={activeSub} activeId={activeQId} onSelect={handleQuestionSelect} tone={tone} />
            </div>
        </div>
    )

    return (
        <>
            <Navbar />
            <div className="has-tilebar" style={{ height: "100vh", paddingTop: "var(--nav-h)", display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {/* Header bar */}
                <div className="iq-bar">
                    <h1>Interview Q&amp;A</h1>
                    {!isMobile && <span className="iq-count">{pairs.length} topics</span>}

                    {/* Mobile tab switcher */}
                    {isMobile && (
                        <Tabs idPrefix="iq" label="Interview panels" value={mobileTab} onChange={setMobileTab} items={MOBILE_TABS} block />
                    )}
                </div>

                {/* Desktop: three-column flex layout */}
                {!isMobile ? (
                    <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
                        {/* Left — 20% */}
                        <div style={{ width: '20%', minWidth: 160, flexShrink: 0, overflow: 'hidden', background: 'var(--surface-2)' }}>
                            {LeftPanel}
                        </div>
                        {/* Middle — 47% */}
                        <div style={{ flex: '1 1 0', overflow: 'hidden', background: 'var(--surface-2)' }}>
                            {MiddlePanel}
                        </div>
                        {/* Right — 33% */}
                        <div style={{ width: '33%', minWidth: 240, flexShrink: 0, overflow: 'hidden', background: 'var(--surface-2)', borderLeft: '1px solid var(--subtle)' }}>
                            {RightPanel}
                        </div>
                    </div>
                ) : (
                    // Mobile: single pane, tab-controlled
                    <div role="tabpanel" id={`iq-panel-${mobileTab}`} aria-labelledby={`iq-tab-${mobileTab}`}
                        style={{ flex: 1, overflow: 'hidden', background: 'var(--surface-2)' }}>
                        {mobileTab === 'subcategories' && LeftPanel}
                        {mobileTab === 'answer' && MiddlePanel}
                        {mobileTab === 'questions' && RightPanel}
                    </div>
                )}
            </div>
        </>
    )
}

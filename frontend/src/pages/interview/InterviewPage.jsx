import { useState, useEffect } from 'react'
import Navbar from '../../components/Navbar'
import { useInterviewSubcategories } from '../../lib/useInterviewQuestions'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { ssGet, ssSet } from '../../lib/sessionStore'
import SubcategoryList from '../../components/interview/SubcategoryList'
import QuestionList from '../../components/interview/QuestionList'
import AnswerViewer from '../../components/interview/AnswerViewer'
import { accentForSubcategory } from '../../components/interview/categoryTheme'

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

    // Active category hue — resolved from the selected subcategory against the
    // loaded (category, subcategory) pairs. Threaded to all three panels.
    const accent = accentForSubcategory(pairs, activeSub)

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
            <div style={{ padding: '10px 14px 8px', borderBottom: '1px solid var(--subtle)', flexShrink: 0 }}>
                <span style={{ fontSize: '0.6rem', fontWeight: 900, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Topics</span>
            </div>
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
            {activeQId && (
                <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--subtle)', flexShrink: 0 }}>
                    <span style={{ fontSize: '0.6rem', fontWeight: 900, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Answer</span>
                </div>
            )}
            <div style={{ flex: 1, overflow: 'hidden' }}>
                <AnswerViewer questionId={activeQId} questionText={activeQText} accent={accent} />
            </div>
        </div>
    )

    const RightPanel = (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid var(--subtle)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: '0.6rem', fontWeight: 900, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '0.1em', flex: 1 }}>Questions</span>
                {activeSub && (
                    <span style={{
                        fontSize: '0.65rem', color: accent, fontWeight: 700,
                        border: `1px solid ${accent}59`, borderRadius: 4, padding: '2px 7px',
                        whiteSpace: 'nowrap',
                    }}>{activeSub}</span>
                )}
            </div>
            <div style={{ flex: 1, overflow: 'auto' }}>
                <QuestionList subcategory={activeSub} activeId={activeQId} onSelect={handleQuestionSelect} accent={accent} />
            </div>
        </div>
    )

    return (
        <>
            <Navbar />
            <div style={{ height: '100vh', paddingTop: 56, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {/* Header bar */}
                <div style={{ borderBottom: '1px solid var(--subtle)', background: 'var(--surface-2)', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, flexWrap: 'wrap' }}>
                    <h2 style={{ fontSize: '0.9rem', fontWeight: 900, color: 'var(--bright)', letterSpacing: '-0.02em' }}>Interview Q&amp;A</h2>
                    {!isMobile && <span style={{ color: 'var(--subtle)' }}>|</span>}
                    {!isMobile && (
                        <span style={{ fontSize: '0.72rem', color: 'var(--faint)' }}>
                            {pairs.length} subcategories
                        </span>
                    )}

                    {/* Mobile tab switcher */}
                    {isMobile && (
                        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, flex: '1 1 220px', minWidth: 0 }}>
                            {[
                                { id: 'subcategories', label: 'Topics' },
                                { id: 'questions', label: 'Questions' },
                                { id: 'answer', label: 'Answer' },
                            ].map(t => (
                                <button key={t.id} type="button" onClick={() => setMobileTab(t.id)} style={{
                                    flex: 1, minWidth: 0,
                                    padding: '5px 8px', borderRadius: 4, border: 'none', cursor: 'pointer',
                                    fontSize: '0.62rem', fontWeight: 900, textTransform: 'uppercase',
                                    background: mobileTab === t.id ? '#22d3ee' : 'var(--subtle)',
                                    color: mobileTab === t.id ? 'var(--surface)' : 'var(--muted)',
                                    transition: 'background 0.12s',
                                }}>
                                    {t.label}
                                </button>
                            ))}
                        </div>
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
                    <div style={{ flex: 1, overflow: 'hidden', background: 'var(--surface-2)' }}>
                        {mobileTab === 'subcategories' && LeftPanel}
                        {mobileTab === 'answer' && <div style={{ height: '100%', background: 'var(--surface-2)' }}>{MiddlePanel}</div>}
                        {mobileTab === 'questions' && RightPanel}
                    </div>
                )}
            </div>
        </>
    )
}

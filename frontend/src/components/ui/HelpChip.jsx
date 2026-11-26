import { useState } from 'react'
import { GLOSSARY } from '../../lib/copy'
import Sheet from './Sheet'

/**
 * Small "?" button next to an unavoidable term. Opens a Sheet with the 2-line
 * explanation from lib/copy.js GLOSSARY. 24px visual, 44px hit area.
 *
 *   <h2>Packs <HelpChip term="pack" /></h2>
 *   <HelpChip term="hld" label="What is system design?" />
 *
 * term: a GLOSSARY key (pack, answersNeeded, portalLogins, skipped, results, matchCount,
 *       dsa, lld, hld, referral, resumeCheck, plan). Unknown keys render nothing.
 * label: accessible name (default "What is <term>?")
 */
export default function HelpChip({ term, label, className = '' }) {
    const [open, setOpen] = useState(false)
    const entry = GLOSSARY[term]
    if (!entry) return null
    return (
        <>
            <button
                type="button"
                className={`sys-help ${className}`.trim()}
                aria-label={label || `What is ${entry.term}?`}
                aria-haspopup="dialog"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true) }}
            >
                <span aria-hidden="true">?</span>
            </button>
            <Sheet open={open} onClose={() => setOpen(false)} title={entry.term}>
                <p className="sys-help-text">{entry.short}</p>
            </Sheet>
        </>
    )
}

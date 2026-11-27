import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronDown } from 'lucide-react'

// Splits markdown into an intro + heading sections so long content reads as a
// short summary first, with each section behind an expander (no walls of text).
// Fence-aware: "## " lines inside ``` code blocks never start a section.
export function splitMarkdownSections(md = '') {
    const lines = String(md || '').split(/\r?\n/)
    // Pick the shallowest heading level (1-3) that occurs outside code fences.
    let fence = false
    let level = 0
    for (const l of lines) {
        if (/^\s*(```|~~~)/.test(l)) { fence = !fence; continue }
        if (fence) continue
        const m = /^(#{1,3})\s+\S/.exec(l)
        if (m && (!level || m[1].length < level)) level = m[1].length
    }
    if (!level) return { intro: String(md || '').trim(), sections: [] }

    const intro = []
    const sections = []
    let cur = null
    fence = false
    const re = new RegExp(`^#{${level}}\\s+(.+?)\\s*#*\\s*$`)
    for (const l of lines) {
        if (/^\s*(```|~~~)/.test(l)) fence = !fence
        const m = !fence && re.exec(l)
        if (m) {
            cur = { title: m[1].replace(/[*_`]/g, ''), body: [] }
            sections.push(cur)
            continue
        }
        ;(cur ? cur.body : intro).push(l)
    }
    return {
        intro: intro.join('\n').trim(),
        sections: sections.map((s) => ({ title: s.title, body: s.body.join('\n').trim() })).filter((s) => s.title),
    }
}

/**
 * Summary-first markdown: the intro (text before the first heading) is shown,
 * every heading section is a <details> expander. When there is no intro, the
 * first section starts open so the page never opens on a column of closed rows.
 *
 * render: optional (markdown) => node, e.g. the interview MarkdownRenderer.
 * className: wrapper class (e.g. "markdown-body").
 */
export default function CollapsibleMarkdown({ children, render, className = '', openFirst }) {
    const { intro, sections } = splitMarkdownSections(children)
    const md = render || ((src) => <ReactMarkdown remarkPlugins={[remarkGfm]}>{src}</ReactMarkdown>)
    const firstOpen = openFirst ?? !intro
    return (
        <div className={`pr-cmd ${className}`.trim()}>
            {intro && <div className="pr-cmd-intro">{md(intro)}</div>}
            {sections.map((s, i) => (
                <details key={`${i}-${s.title}`} className="pr-x" open={firstOpen && i === 0 ? true : undefined}>
                    <summary className="pr-x-sum">
                        <span className="pr-x-title">{s.title}</span>
                        <ChevronDown size={18} className="pr-x-chev" aria-hidden="true" />
                    </summary>
                    <div className="pr-x-body">{s.body ? md(s.body) : null}</div>
                </details>
            ))}
        </div>
    )
}

/** One expander with any content (same look as the markdown sections). */
export function Expander({ title, meta, children, defaultOpen = false, className = '' }) {
    return (
        <details className={`pr-x ${className}`.trim()} open={defaultOpen || undefined}>
            <summary className="pr-x-sum">
                <span className="pr-x-title">{title}</span>
                {meta && <span className="pr-x-meta">{meta}</span>}
                <ChevronDown size={18} className="pr-x-chev" aria-hidden="true" />
            </summary>
            <div className="pr-x-body">{children}</div>
        </details>
    )
}

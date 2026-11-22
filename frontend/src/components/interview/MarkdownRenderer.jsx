import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import MermaidBlock from './MermaidBlock'

// ── Fenced code block (mermaid diagrams get routed to MermaidBlock) ──
function CodeBlock({ className, children }) {
    const lang = (className || '').replace('language-', '')
    const code = String(children).trim()
    if (lang === 'mermaid') return <MermaidBlock code={code} />
    return (
        <pre style={{
            background: 'var(--surface-2)', border: '1px solid var(--subtle)', borderRadius: 6,
            padding: '12px 14px', overflowX: 'auto', maxWidth: '100%', fontSize: '0.78rem',
            lineHeight: 1.6, margin: '10px 0',
        }}>
            <code style={{ color: 'var(--accent)' }}>{code}</code>
        </pre>
    )
}

const COMPONENTS = {
    // react-markdown v10 no longer passes `inline`; derive block vs inline
    // from the language class or the presence of a newline.
    code: ({ className, children }) => {
        const isBlock = /language-(\w+)/.test(className || '') || String(children).includes('\n')
        return isBlock
            ? <CodeBlock className={className}>{children}</CodeBlock>
            : <code style={{ background: '#1a1a1e', border: '1px solid var(--subtle)', borderRadius: 4, padding: '1px 5px', fontSize: '0.82em', color: '#22d3ee', overflowWrap: 'anywhere' }}>{children}</code>
    },
    h1: ({ children }) => <h1 style={{ fontSize: '1.05rem', fontWeight: 900, color: 'var(--bright)', marginBottom: 8, marginTop: 20, paddingLeft: 10, borderLeft: '2px solid #22d3ee', letterSpacing: '-0.02em' }}>{children}</h1>,
    h2: ({ children }) => <h2 style={{ fontSize: '0.95rem', fontWeight: 900, color: 'var(--bright)', marginBottom: 6, marginTop: 18, paddingLeft: 10, borderLeft: '2px solid #22d3ee', letterSpacing: '-0.01em' }}>{children}</h2>,
    h3: ({ children }) => <h3 style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--accent)', marginBottom: 4, marginTop: 14, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{children}</h3>,
    p: ({ children }) => <p style={{ marginBottom: 10, color: 'var(--accent)' }}>{children}</p>,
    ul: ({ children }) => <ul style={{ paddingLeft: 18, marginBottom: 10 }}>{children}</ul>,
    ol: ({ children }) => <ol style={{ paddingLeft: 18, marginBottom: 10 }}>{children}</ol>,
    li: ({ children }) => <li style={{ marginBottom: 4 }}>{children}</li>,
    strong: ({ children }) => <strong style={{ color: 'var(--bright)', fontWeight: 700 }}>{children}</strong>,
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#22d3ee', textDecoration: 'none' }}>{children}</a>,
    blockquote: ({ children }) => (
        <blockquote style={{ borderLeft: '3px solid #22d3ee', margin: '10px 0', paddingLeft: 14, color: 'var(--muted)', fontStyle: 'italic' }}>{children}</blockquote>
    ),
    table: ({ children }) => (
        <div style={{ overflowX: 'auto', marginBottom: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>{children}</table>
        </div>
    ),
    th: ({ children }) => <th style={{ borderBottom: '1px solid var(--subtle)', padding: '6px 10px', textAlign: 'left', color: 'var(--bright)', fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{children}</th>,
    td: ({ children }) => <td style={{ borderBottom: '1px solid var(--panel)', padding: '6px 10px', color: 'var(--accent)' }}>{children}</td>,
    hr: () => <hr style={{ border: 'none', borderTop: '1px solid var(--subtle)', margin: '16px 0' }} />,
}

export default function MarkdownRenderer({ children }) {
    return (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
            {children}
        </ReactMarkdown>
    )
}

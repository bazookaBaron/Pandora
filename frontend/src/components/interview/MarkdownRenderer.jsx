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
            background: '#0d0d0f', border: '1px solid #27272a', borderRadius: 6,
            padding: '12px 14px', overflowX: 'auto', maxWidth: '100%', fontSize: '0.78rem',
            lineHeight: 1.6, margin: '10px 0',
        }}>
            <code style={{ color: '#a1a1aa' }}>{code}</code>
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
            : <code style={{ background: '#1a1a1e', border: '1px solid #27272a', borderRadius: 4, padding: '1px 5px', fontSize: '0.82em', color: '#22d3ee', overflowWrap: 'anywhere' }}>{children}</code>
    },
    h1: ({ children }) => <h1 style={{ fontSize: '1.05rem', fontWeight: 900, color: '#e4e4e7', marginBottom: 8, marginTop: 20, paddingLeft: 10, borderLeft: '2px solid #22d3ee', letterSpacing: '-0.02em' }}>{children}</h1>,
    h2: ({ children }) => <h2 style={{ fontSize: '0.95rem', fontWeight: 900, color: '#e4e4e7', marginBottom: 6, marginTop: 18, paddingLeft: 10, borderLeft: '2px solid #22d3ee', letterSpacing: '-0.01em' }}>{children}</h2>,
    h3: ({ children }) => <h3 style={{ fontSize: '0.85rem', fontWeight: 700, color: '#a1a1aa', marginBottom: 4, marginTop: 14, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{children}</h3>,
    p: ({ children }) => <p style={{ marginBottom: 10, color: '#a1a1aa' }}>{children}</p>,
    ul: ({ children }) => <ul style={{ paddingLeft: 18, marginBottom: 10 }}>{children}</ul>,
    ol: ({ children }) => <ol style={{ paddingLeft: 18, marginBottom: 10 }}>{children}</ol>,
    li: ({ children }) => <li style={{ marginBottom: 4 }}>{children}</li>,
    strong: ({ children }) => <strong style={{ color: '#fafafa', fontWeight: 700 }}>{children}</strong>,
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#22d3ee', textDecoration: 'none' }}>{children}</a>,
    blockquote: ({ children }) => (
        <blockquote style={{ borderLeft: '3px solid #22d3ee', margin: '10px 0', paddingLeft: 14, color: '#71717a', fontStyle: 'italic' }}>{children}</blockquote>
    ),
    table: ({ children }) => (
        <div style={{ overflowX: 'auto', marginBottom: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>{children}</table>
        </div>
    ),
    th: ({ children }) => <th style={{ borderBottom: '1px solid #27272a', padding: '6px 10px', textAlign: 'left', color: '#fafafa', fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{children}</th>,
    td: ({ children }) => <td style={{ borderBottom: '1px solid #1e1e22', padding: '6px 10px', color: '#a1a1aa' }}>{children}</td>,
    hr: () => <hr style={{ border: 'none', borderTop: '1px solid #27272a', margin: '16px 0' }} />,
}

export default function MarkdownRenderer({ children }) {
    return (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
            {children}
        </ReactMarkdown>
    )
}

import { useState, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import Editor from '@monaco-editor/react'
import { Panel, Group, Separator } from 'react-resizable-panels'
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import JSZip from 'jszip'
import { supabase } from '../../lib/supabase'
import { useProgress } from '../../lib/useProgress'
import Navbar from '../../components/Navbar'
import FluidCheckbox from '../../components/shared/FluidCheckbox'
import DifficultyBadge from '../../components/shared/DifficultyBadge'

// ── File tree utilities ────────────────────────────────────────────
function buildTree(files) {
    const root = {}
    files.forEach(f => {
        const parts = (f.filepath || f.filename || '').split('/')
        let node = root
        parts.forEach((part, i) => {
            if (!node[part]) node[part] = i === parts.length - 1 ? { __file: f } : {}
            node = node[part]
        })
    })
    return root
}

const EXT_LANG = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    java: 'java', py: 'python', cs: 'csharp', go: 'go', cpp: 'cpp', c: 'c',
    rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
    md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml',
    html: 'html', css: 'css', sh: 'shell', sql: 'sql',
}
const EXT_ICON = {
    js: '🟨', jsx: '⚛️', ts: '🔷', tsx: '⚛️', java: '☕', py: '🐍',
    cs: '🔵', go: '🐹', cpp: '🔩', rs: '🦀', md: '📝', json: '📦',
    default: '📄',
}
function extOf(name = '') { return name.split('.').pop().toLowerCase() }
function langOf(name = '') { return EXT_LANG[extOf(name)] || 'plaintext' }
function iconOf(name = '') { return EXT_ICON[extOf(name)] || EXT_ICON.default }

function FileTree({ node, depth = 0, onOpen, openFiles, activeFile }) {
    const [collapsed, setCollapsed] = useState({})
    return (
        <div>
            {Object.entries(node).sort(([aKey, aVal], [bKey, bVal]) => {
                const aIsFile = !!aVal?.__file, bIsFile = !!bVal?.__file
                if (aIsFile !== bIsFile) return aIsFile ? 1 : -1
                return aKey.localeCompare(bKey)
            }).map(([key, val]) => {
                const isFile = !!val?.__file
                const isActive = isFile && activeFile?.id === val.__file.id
                if (isFile) {
                    return (
                        <div key={key}
                            onClick={() => onOpen(val.__file)}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 6,
                                padding: `4px 8px 4px ${12 + depth * 14}px`,
                                cursor: 'pointer', borderRadius: 4, margin: '1px 0',
                                background: isActive ? 'rgba(244,114,182,0.12)' : 'transparent',
                                color: isActive ? '#f472b6' : '#a1a1aa',
                                fontSize: '0.78rem',
                                transition: 'background 0.1s, color 0.1s',
                                borderLeft: isActive ? '2px solid #f472b6' : '2px solid transparent',
                            }}
                            onMouseEnter={e => { if (!isActive) { e.currentTarget.style.background = '#27272a'; e.currentTarget.style.color = '#fafafa' } }}
                            onMouseLeave={e => { if (!isActive) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#a1a1aa' } }}
                        >
                            <span style={{ flexShrink: 0 }}>{iconOf(key)}</span>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{key}</span>
                        </div>
                    )
                }
                const isOpen = !collapsed[key]
                return (
                    <div key={key}>
                        <div onClick={() => setCollapsed(c => ({ ...c, [key]: !c[key] }))}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 5,
                                padding: `4px 8px 4px ${12 + depth * 14}px`,
                                cursor: 'pointer', color: '#71717a', fontSize: '0.75rem', fontWeight: 700,
                                textTransform: 'uppercase', letterSpacing: '0.04em',
                            }}
                            onMouseEnter={e => e.currentTarget.style.color = '#fafafa'}
                            onMouseLeave={e => e.currentTarget.style.color = '#71717a'}
                        >
                            <span style={{ fontSize: '0.6rem' }}>{isOpen ? '▼' : '▶'}</span>
                            <span>📁</span>
                            <span>{key}</span>
                        </div>
                        {isOpen && <FileTree node={val} depth={depth + 1} onOpen={onOpen} openFiles={openFiles} activeFile={activeFile} />}
                    </div>
                )
            })}
        </div>
    )
}

// ── Main component ─────────────────────────────────────────────────
export default function LLDProblemPage() {
    const { slug } = useParams()
    const [openFiles, setOpenFiles] = useState([])
    const [activeFile, setActiveFile] = useState(null)
    const [notesOpen, setNotesOpen] = useState(false)
    const [notesText, setNotesText] = useState('')
    const [mobileTab, setMobileTab] = useState('requirements') // 'requirements' | 'diagram' | 'code'
    const [copyMsg, setCopyMsg] = useState('')

    const { data: problem, isLoading: probLoading } = useQuery({
        queryKey: ['lld-problem', slug],
        queryFn: async () => {
            const { data, error } = await supabase
                .from('lld_problems')
                .select('*')
                .eq('slug', slug)
                .single()
            if (error) throw error
            return data
        },
    })

    const { data: diagrams = [] } = useQuery({
        queryKey: ['lld-diagrams', problem?.id],
        queryFn: async () => {
            const { data, error } = await supabase
                .from('lld_class_diagrams')
                .select('*')
                .eq('problem_id', problem.id)
            if (error) throw error
            return data || []
        },
        enabled: !!problem?.id,
    })

    const { data: codeFiles = [] } = useQuery({
        queryKey: ['lld-code', problem?.id],
        queryFn: async () => {
            const { data, error } = await supabase
                .from('lld_code_files')
                .select('*')
                .eq('problem_id', problem.id)
            if (error) throw error
            return data || []
        },
        enabled: !!problem?.id,
    })

    const { progressMap, toggleStatus, saveNotes } = useProgress('lld')
    const prog = problem ? progressMap[problem.id] : null
    const isSolved = prog?.status === 'solved'

    // Initialize notes from DB when loaded
    useMemo(() => {
        if (prog?.notes && !notesText) setNotesText(prog.notes)
    }, [prog])

    const fileTree = useMemo(() => buildTree(codeFiles), [codeFiles])

    const openFile = (file) => {
        setOpenFiles(prev => prev.find(f => f.id === file.id) ? prev : [...prev, file])
        setActiveFile(file)
    }
    const closeFile = (fileId) => {
        const remaining = openFiles.filter(f => f.id !== fileId)
        setOpenFiles(remaining)
        setActiveFile(remaining.length ? remaining[remaining.length - 1] : null)
    }

    const copyFile = async () => {
        if (!activeFile) return
        await navigator.clipboard.writeText(activeFile.content || '')
        setCopyMsg('Copied!')
        setTimeout(() => setCopyMsg(''), 2000)
    }

    const downloadZip = async () => {
        const zip = new JSZip()
        codeFiles.forEach(f => zip.file(f.filepath || f.filename, f.content || ''))
        const blob = await zip.generateAsync({ type: 'blob' })
        const url = URL.createObjectURL(blob)
        const a = Object.assign(document.createElement('a'), { href: url, download: `${slug}.zip` })
        document.body.appendChild(a); a.click(); a.remove()
        URL.revokeObjectURL(url)
    }

    if (probLoading) {
        return (
            <>
                <Navbar />
                <div style={{ paddingTop: 80, textAlign: 'center', color: '#71717a' }}>Loading problem…</div>
            </>
        )
    }

    if (!problem) {
        return (
            <>
                <Navbar />
                <div style={{ paddingTop: 80, textAlign: 'center' }}>
                    <p style={{ color: '#f87171' }}>Problem not found.</p>
                    <Link to="/lld" style={{ color: '#f472b6', fontSize: '0.82rem' }}>← Back to LLD</Link>
                </div>
            </>
        )
    }

    // ── Pane contents ──────────────────────────────────────────────
    const RequirementsPane = (
        <div style={{ padding: 16, height: '100%', overflowY: 'auto' }}>
            <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: '0.62rem', fontWeight: 900, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Requirements</span>
                {problem.difficulty && <DifficultyBadge difficulty={problem.difficulty} />}
            </div>
            <div className="markdown-body" style={{ fontSize: '0.83rem', lineHeight: 1.7 }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{problem.requirements || '_No requirements provided._'}</ReactMarkdown>
            </div>

            {/* Notes */}
            <div style={{ marginTop: 20, borderTop: '1px solid #27272a', paddingTop: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: '0.62rem', fontWeight: 900, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Approach Notes</span>
                    {notesOpen && (
                        <button onClick={() => { saveNotes(problem.id, notesText); setNotesOpen(false) }}
                            style={{ fontSize: '0.68rem', padding: '3px 10px', background: '#f472b6', color: '#09090b', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 900 }}>
                            Save
                        </button>
                    )}
                </div>
                {notesOpen ? (
                    <textarea
                        value={notesText}
                        onChange={e => setNotesText(e.target.value)}
                        placeholder="Your approach, patterns used, time complexity…"
                        rows={5}
                        style={{
                            width: '100%', background: '#18181b', border: '1px solid #27272a', borderRadius: 6,
                            color: '#fafafa', font: 'inherit', fontSize: '0.8rem', padding: '8px 10px',
                            resize: 'vertical', outline: 'none',
                        }}
                        autoFocus
                    />
                ) : (
                    <button onClick={() => setNotesOpen(true)} style={{
                        width: '100%', padding: '8px 12px', background: '#18181b', border: '1px dashed #27272a',
                        borderRadius: 6, color: '#52525b', cursor: 'pointer', fontSize: '0.78rem', textAlign: 'left',
                    }}>
                        {notesText || '+ Add notes…'}
                    </button>
                )}
            </div>
        </div>
    )

    const DiagramPane = (
        <div style={{ height: '100%', overflow: 'hidden', position: 'relative' }}>
            <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 10, display: 'flex', gap: 6 }}>
                <span style={{ fontSize: '0.6rem', fontWeight: 900, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.08em', alignSelf: 'center' }}>UML</span>
                {diagrams[0]?.original_url && (
                    <a href={diagrams[0].original_url} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: '0.65rem', padding: '3px 8px', background: '#27272a', border: '1px solid #3f3f46', borderRadius: 4, color: '#a1a1aa', textDecoration: 'none' }}>
                        Full res ↗
                    </a>
                )}
            </div>
            {diagrams.length > 0 ? (
                <TransformWrapper minScale={0.3} maxScale={5} initialScale={1}>
                    <TransformComponent wrapperStyle={{ width: '100%', height: '100%' }}>
                        <img
                            src={diagrams[0].image_url}
                            alt="Class diagram"
                            style={{ maxWidth: '100%', display: 'block' }}
                        />
                    </TransformComponent>
                </TransformWrapper>
            ) : (
                <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#52525b', fontSize: '0.8rem' }}>
                    No diagram available
                </div>
            )}
        </div>
    )

    const CodePane = (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Toolbar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderBottom: '1px solid #27272a', background: '#0d0d0f', flexShrink: 0 }}>
                <span style={{ fontSize: '0.6rem', fontWeight: 900, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    {codeFiles.length} files
                </span>
                <div style={{ flex: 1 }} />
                <button onClick={copyFile} disabled={!activeFile} style={{
                    padding: '3px 10px', background: 'none', border: '1px solid #27272a', borderRadius: 4, color: copyMsg ? '#4ade80' : '#71717a', cursor: 'pointer', fontSize: '0.68rem',
                }}>
                    {copyMsg || 'Copy File'}
                </button>
                <button onClick={downloadZip} disabled={!codeFiles.length} style={{
                    padding: '3px 10px', background: 'none', border: '1px solid #27272a', borderRadius: 4, color: '#71717a', cursor: 'pointer', fontSize: '0.68rem',
                }}>
                    ⬇ ZIP
                </button>
            </div>

            {/* File tabs */}
            {openFiles.length > 0 && (
                <div style={{ display: 'flex', overflowX: 'auto', background: '#0d0d0f', borderBottom: '1px solid #27272a', flexShrink: 0 }}>
                    {openFiles.map(f => {
                        const fname = (f.filepath || f.filename || '').split('/').pop()
                        const isActive = activeFile?.id === f.id
                        return (
                            <div key={f.id} onClick={() => setActiveFile(f)} style={{
                                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
                                cursor: 'pointer', flexShrink: 0, borderRight: '1px solid #27272a',
                                background: isActive ? '#1e1e1e' : 'transparent',
                                borderBottom: isActive ? '2px solid #f472b6' : '2px solid transparent',
                                color: isActive ? '#fafafa' : '#71717a', fontSize: '0.75rem',
                                transition: 'color 0.15s',
                            }}>
                                <span style={{ flexShrink: 0 }}>{iconOf(fname)}</span>
                                <span style={{ whiteSpace: 'nowrap' }}>{fname}</span>
                                <button onClick={(e) => { e.stopPropagation(); closeFile(f.id) }}
                                    style={{ background: 'none', border: 'none', color: '#52525b', cursor: 'pointer', fontSize: 13, padding: '0 2px', lineHeight: 1, marginLeft: 2 }}>
                                    ×
                                </button>
                            </div>
                        )
                    })}
                </div>
            )}

            {/* Editor area */}
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
                {/* File tree (left column) */}
                <div style={{ width: 200, borderRight: '1px solid #27272a', overflowY: 'auto', background: '#0d0d0f', flexShrink: 0 }}>
                    {codeFiles.length === 0 ? (
                        <div style={{ padding: 12, color: '#52525b', fontSize: '0.72rem' }}>No code files</div>
                    ) : (
                        <FileTree node={fileTree} onOpen={openFile} openFiles={openFiles} activeFile={activeFile} />
                    )}
                </div>

                {/* Monaco */}
                <div style={{ flex: 1, overflow: 'hidden' }}>
                    {activeFile ? (
                        <Editor
                            key={activeFile.id}
                            height="100%"
                            language={langOf(activeFile.filepath || activeFile.filename || '')}
                            value={activeFile.content || ''}
                            theme="vs-dark"
                            options={{
                                readOnly: true,
                                domReadOnly: true,
                                minimap: { enabled: true },
                                fontSize: 13,
                                lineNumbers: 'on',
                                scrollBeyondLastLine: false,
                                wordWrap: 'off',
                                renderWhitespace: 'selection',
                                folding: true,
                                bracketPairColorization: { enabled: true },
                            }}
                        />
                    ) : (
                        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#52525b', gap: 8 }}>
                            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                            <span style={{ fontSize: '0.78rem' }}>Select a file from the tree</span>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )

    // ── Responsive check (simple CSS media query substitute) ────────
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768

    return (
        <>
            <Navbar />
            <div style={{ height: '100vh', paddingTop: 48, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {/* Problem header bar */}
                <div style={{ borderBottom: '1px solid #27272a', background: '#0d0d0f', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                    <Link to="/lld" style={{ color: '#71717a', textDecoration: 'none', fontSize: '0.75rem' }}>← LLD</Link>
                    <span style={{ color: '#27272a' }}>|</span>
                    <h2 style={{ fontSize: '0.95rem', fontWeight: 900, color: '#fafafa', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{problem.title}</h2>
                    {problem.difficulty && <DifficultyBadge difficulty={problem.difficulty} />}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <FluidCheckbox
                            checked={isSolved}
                            onChange={() => toggleStatus(problem.id, prog?.status ?? 'unsolved')}
                        />
                        <span style={{ fontSize: '0.68rem', color: isSolved ? '#f472b6' : '#71717a', fontWeight: 700 }}>
                            {isSolved ? 'Practiced' : 'Mark practiced'}
                        </span>
                    </div>

                    {/* Mobile tabs */}
                    {isMobile && (
                        <div style={{ display: 'flex', gap: 4 }}>
                            {['requirements', 'diagram', 'code'].map(t => (
                                <button key={t} onClick={() => setMobileTab(t)} style={{
                                    padding: '4px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: '0.65rem', fontWeight: 900, textTransform: 'uppercase',
                                    background: mobileTab === t ? '#f472b6' : '#27272a',
                                    color: mobileTab === t ? '#09090b' : '#71717a',
                                }}>
                                    {t.slice(0, 3)}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Desktop: three-pane resizable layout */}
                {!isMobile ? (
                    <Group direction="horizontal" style={{ flex: 1, overflow: 'hidden' }}>
                        {/* Left pane: requirements (top) + diagram (bottom) */}
                        <Panel defaultSize={35} minSize={20} style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                            <Group direction="vertical" style={{ flex: 1 }}>
                                <Panel defaultSize={55} minSize={20} style={{ overflow: 'hidden', background: '#111113' }}>
                                    {RequirementsPane}
                                </Panel>
                                <Separator style={{ height: 4, background: '#27272a', cursor: 'row-resize' }} />
                                <Panel defaultSize={45} minSize={15} style={{ overflow: 'hidden', background: '#0d0d0f' }}>
                                    {DiagramPane}
                                </Panel>
                            </Group>
                        </Panel>

                        <Separator style={{ width: 4, background: '#27272a', cursor: 'col-resize' }} />

                        {/* Right pane: code viewer */}
                        <Panel defaultSize={65} minSize={30} style={{ overflow: 'hidden' }}>
                            {CodePane}
                        </Panel>
                    </Group>
                ) : (
                    // Mobile: tab view
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                        {mobileTab === 'requirements' && <div style={{ height: '100%', overflow: 'auto', background: '#111113' }}>{RequirementsPane}</div>}
                        {mobileTab === 'diagram' && <div style={{ height: '100%', overflow: 'hidden', background: '#0d0d0f' }}>{DiagramPane}</div>}
                        {mobileTab === 'code' && <div style={{ height: '100%', overflow: 'hidden' }}>{CodePane}</div>}
                    </div>
                )}
            </div>
        </>
    )
}

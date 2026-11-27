import { useState, useMemo, useRef, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import Editor from '@monaco-editor/react'
import { Panel, Group, Separator } from 'react-resizable-panels'
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch'
import { supabase } from '../../lib/supabase'
import { useProgress } from '../../lib/useProgress'
import { useAuth } from '../../contexts/AuthContext'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { apiFetch, ApiError } from '../../lib/apiClient'
import { LockedPanel } from '../../components/shared/PaywallGate'
import { LoadingState, ErrorState, EmptyState } from '../../components/shared/states'
import { track, EVENTS } from '../../lib/analytics'
import Navbar from '../../components/Navbar'
import FluidCheckbox from '../../components/shared/FluidCheckbox'
import DifficultyBadge from '../../components/shared/DifficultyBadge'
import { Button, PageHeader, SmallTabs } from '../../components/ui'
import CollapsibleMarkdown, { Expander } from '../../components/interview/CollapsibleMarkdown'
import { TERMS } from '../../lib/copy'
import { ChevronLeft, Copy, Check, Download, Play } from 'lucide-react'

// Feature flag: the sandboxed code runner (▶ Run → /api/run → Piston) is not
// deployed yet. Flip to true once the isolated Piston service is live. The whole
// run/console UI is gated on this so nothing user-facing references it meanwhile.
const LLD_RUNNER_ENABLED = false

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

// Detect the entry-point file (the one holding the program's main()).
// Mirrors the Run button's Java detection, with fallbacks for other languages.
function findEntryFile(files = []) {
    const patterns = [
        /(?:public\s+static|static\s+public)\s+(?:final\s+)?void\s+main\s*\(/, // java
        /if\s+__name__\s*==\s*['"]__main__['"]/,                               // python
        /static\s+(?:async\s+)?(?:void|Task|int)\s+Main\s*\(/,                 // c#
        /func\s+main\s*\(/,                                                    // go
        /\bint\s+main\s*\(/,                                                   // c / c++
    ]
    for (const re of patterns) {
        const hit = files.find(f => re.test(f.content || ''))
        if (hit) return hit
    }
    return null
}

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
                            role="button"
                            tabIndex={0}
                            onClick={() => onOpen(val.__file)}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(val.__file) } }}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 6,
                                padding: `4px 8px 4px ${12 + depth * 14}px`,
                                cursor: 'pointer', borderRadius: 4, margin: '1px 0',
                                background: isActive ? 'var(--warm-dim)' : 'transparent',
                                color: isActive ? 'var(--warm)' : 'var(--accent)',
                                fontSize: '0.78rem',
                                transition: 'background 0.1s, color 0.1s',
                                borderLeft: isActive ? '2px solid var(--warm)' : '2px solid transparent',
                            }}
                            onMouseEnter={e => { if (!isActive) { e.currentTarget.style.background = 'var(--subtle)'; e.currentTarget.style.color = 'var(--bright)' } }}
                            onMouseLeave={e => { if (!isActive) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--accent)' } }}
                        >
                            <span style={{ flexShrink: 0 }}>{iconOf(key)}</span>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{key}</span>
                        </div>
                    )
                }
                const isOpen = !collapsed[key]
                return (
                    <div key={key}>
                        <div role="button"
                            tabIndex={0}
                            onClick={() => setCollapsed(c => ({ ...c, [key]: !c[key] }))}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(c => ({ ...c, [key]: !c[key] })) } }}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 5,
                                padding: `4px 8px 4px ${12 + depth * 14}px`,
                                cursor: 'pointer', color: 'var(--muted)', fontSize: '0.75rem', fontWeight: 700,
                                textTransform: 'uppercase', letterSpacing: '0.04em',
                            }}
                            onMouseEnter={e => e.currentTarget.style.color = 'var(--bright)'}
                            onMouseLeave={e => e.currentTarget.style.color = 'var(--muted)'}
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

// ── Console Panel ─────────────────────────────────────────────────
// Piston response shape: { run: { stdout, stderr, code, output }, compile?: { stdout, stderr, code } }
function ConsolePanel({ run, compile, apiError, status, onClose }) {
    const endRef = useRef(null)
    useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [run, compile])

    const hasOutput = run?.stdout || run?.stderr || compile?.stderr || compile?.stdout || apiError

    return (
        <div style={{
            borderTop: '1px solid var(--subtle)', background: 'var(--surface)', flexShrink: 0,
            display: 'flex', flexDirection: 'column', maxHeight: 260, minHeight: 120,
        }}>
            <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px',
                borderBottom: '1px solid var(--panel)', background: 'var(--surface-2)', flexShrink: 0,
            }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: status === 'running' ? 'var(--sys-waiting)' : status === 'done' ? 'var(--green)' : 'var(--faint)', flexShrink: 0, transition: 'background 0.3s' }} />
                <span style={{ fontSize: '0.6rem', fontWeight: 900, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '0.08em', flex: 1 }}>Console</span>
                {run?.code !== undefined && run.code !== 0 && (
                    <span style={{ fontSize: '0.58rem', color: 'var(--red)', fontFamily: 'monospace' }}>exit {run.code}</span>
                )}
                <button type="button" onClick={onClose} aria-label="Close console" style={{ background: 'none', border: 'none', color: 'var(--faint)', cursor: 'pointer', fontSize: '0.75rem', padding: '0 4px' }}>×</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px', fontFamily: 'monospace', fontSize: '0.75rem', lineHeight: 1.6 }}>
                {status === 'running' && (
                    <div style={{ color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--sys-waiting)', animation: 'pulse 1s infinite' }} />
                        Running…
                    </div>
                )}

                {/* Piston API-level error (e.g. unsupported language) */}
                {apiError && (
                    <pre style={{ color: 'var(--red)', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>[API Error]{`\n`}{apiError}</pre>
                )}

                {/* Compile stage errors */}
                {compile?.stderr && (
                    <pre style={{ color: 'var(--sys-waiting)', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>[Compile Error]{`\n`}{compile.stderr}</pre>
                )}
                {compile?.stdout && (
                    <pre style={{ color: 'var(--muted)', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>[Compile Output]{`\n`}{compile.stdout}</pre>
                )}

                {/* Runtime stage */}
                {run?.stderr && (
                    <pre style={{ color: 'var(--red)', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>[Runtime Error]{`\n`}{run.stderr}</pre>
                )}
                {run?.stdout && (
                    <pre style={{ color: 'var(--green)', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{run.stdout}</pre>
                )}

                {status === 'done' && !hasOutput && (
                    <span style={{ color: 'var(--faint)' }}>(no output — program ran successfully with exit code {run?.code ?? '?'})</span>
                )}
                <div ref={endRef} />
            </div>
        </div>
    )
}

const MOBILE_TAB_LABEL = { requirements: 'Summary', diagram: 'Diagram', code: 'Code' }

// ── Main component ─────────────────────────────────────────────────
export default function LLDProblemPage() {
    const { slug } = useParams()
    const [openFiles, setOpenFiles] = useState([])
    const [activeFile, setActiveFile] = useState(null)
    const [notesOpen, setNotesOpen] = useState(false)
    const [notesText, setNotesText] = useState('')
    // 'idle' | 'saving' | 'saved' | 'error'
    const [notesSave, setNotesSave] = useState('idle')
    const [mobileTab, setMobileTab] = useState('requirements') // 'requirements' | 'diagram' | 'code'
    const [treeOpen, setTreeOpen] = useState(false) // mobile: file-tree strip expanded
    const [copyMsg, setCopyMsg] = useState('')
    const [runStatus, setRunStatus] = useState('idle') // 'idle' | 'running' | 'done'
    const [runResult, setRunResult] = useState(null)   // { run, compile, apiError }
    const [showConsole, setShowConsole] = useState(false)

    const { user } = useAuth()

    // ── Authenticated detail fetch ────────────────────────────────────
    // The server returns the full row only when the slug is within the caller's
    // tier allowance; otherwise 403 { error: 'upgrade_required' }. No tier math
    // on the client — `locked` is derived straight from that response.
    const { data, isLoading: probLoading, isError, error } = useQuery({
        queryKey: ['catalog-lld-detail', slug],
        queryFn: () => apiFetch('/api/catalog/lld/' + encodeURIComponent(slug)),
        enabled: !!slug,
        staleTime: 5 * 60_000, // problem content is static; was refetching on every mount
        retry: (count, err) => !(err instanceof ApiError) && count < 2,
    })

    const problem = data?.item || null
    const isMobile = useMediaQuery('(max-width: 767px)')

    const locked = isError && error instanceof ApiError && error.code === 'upgrade_required'

    const { data: diagrams = [], isFetched: diagramsFetched } = useQuery({
        queryKey: ['lld-diagrams', problem?.id],
        queryFn: async () => {
            const { data, error } = await supabase
                .from('lld_class_diagrams')
                .select('*')
                .eq('problem_id', problem.id)
            if (error) throw error
            return data || []
        },
        enabled: !!problem?.id && !locked,
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
        enabled: !!problem?.id && !locked,
    })

    const { progressMap, toggleStatus, saveNotes } = useProgress('lld')
    const prog = problem ? progressMap[problem.id] : null
    const isSolved = prog?.status === 'solved'

    // Hydrate notes from the saved progress row once per problem — keyed on the
    // progress id so a later refetch (e.g. after toggling solved) doesn't clobber
    // in-progress edits.
    const hydratedNotesId = useRef(null)
    useEffect(() => {
        if (!prog || hydratedNotesId.current === prog.id) return
        hydratedNotesId.current = prog.id
        setNotesText(prog.notes || '')
    }, [prog?.id])

    const fileTree = useMemo(() => buildTree(codeFiles), [codeFiles])

    // Analytics guards — keyed on problem id so re-navigating to another problem
    // re-arms them, and StrictMode double-invokes don't double-fire.
    const questionStartedRef = useRef(null)
    const solutionViewedRef = useRef(null)

    // QUESTION_STARTED once per (non-locked) problem.
    useEffect(() => {
        if (locked || !problem?.id) return
        if (questionStartedRef.current === problem.id) return
        questionStartedRef.current = problem.id
        track(EVENTS.QUESTION_STARTED, { type: 'lld', problem_id: problem.id, slug })
    }, [problem?.id, locked, slug])

    const openFile = (file) => {
        setOpenFiles(prev => prev.find(f => f.id === file.id) ? prev : [...prev, file])
        setActiveFile(file)
        // SOLUTION_VIEWED once per problem — first file opened (incl. auto-open).
        if (problem?.id && solutionViewedRef.current !== problem.id) {
            solutionViewedRef.current = problem.id
            track(EVENTS.SOLUTION_VIEWED, { type: 'lld', problem_id: problem.id })
        }
    }
    const closeFile = (fileId) => {
        const remaining = openFiles.filter(f => f.id !== fileId)
        setOpenFiles(remaining)
        setActiveFile(remaining.length ? remaining[remaining.length - 1] : null)
    }

    // Auto-open the entry-point file the first time code files arrive so the
    // editor isn't empty. Guarded so it never overrides a manual selection, only
    // fires once, and never runs when the page is tier-locked. Does not touch
    // `treeOpen`, so on mobile the file strip stays collapsed with the entry
    // file already shown in the editor.
    const didAutoOpenRef = useRef(false)
    useEffect(() => {
        if (didAutoOpenRef.current || locked) return
        if (!codeFiles.length || activeFile) return
        const entry = findEntryFile(codeFiles) || codeFiles[0]
        if (entry) {
            didAutoOpenRef.current = true
            openFile(entry)
        }
    }, [codeFiles, locked])

    const copyFile = async () => {
        if (!activeFile) return
        try {
            await navigator.clipboard.writeText(activeFile.content || '')
            setCopyMsg('Copied!')
        } catch {
            setCopyMsg('Copy failed')
        }
        setTimeout(() => setCopyMsg(''), 2000)
    }

    const downloadZip = async () => {
        const { default: JSZip } = await import('jszip')
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
                <div style={{ paddingTop: "calc(var(--nav-h) + 16px)" }}>
                    <LoadingState label="Loading problem…" />
                </div>
            </>
        )
    }

    if (isError && error?.status === 401) {
        return (
            <>
                <Navbar />
                <div style={{ paddingTop: "calc(var(--nav-h) + 16px)" }}>
                    <ErrorState err={error} />
                    <p style={{ textAlign: 'center', marginTop: 12 }}>
                        <Button to="/lld" icon={ChevronLeft}>Back to {TERMS.lld.one}</Button>
                    </p>
                </div>
            </>
        )
    }

    if (isError && !locked) {
        return (
            <>
                <Navbar />
                <div style={{ paddingTop: "calc(var(--nav-h) + 16px)" }}>
                    <ErrorState title="Could not load this problem." err={error} />
                    <p style={{ textAlign: 'center', marginTop: 12 }}>
                        <Button to="/lld" icon={ChevronLeft}>Back to {TERMS.lld.one}</Button>
                    </p>
                </div>
            </>
        )
    }

    // Free-tier deep-link → server 403. Keep Navbar + a header bar, swap the
    // workspace for a locked panel.
    if (locked) {
        return (
            <>
                <Navbar />
                <div className="pr-ws">
                    <PageHeader section="prepare" className="pr-ws-ph" back={{ to: '/lld', label: TERMS.lld.one }}
                        title="Locked problem" subtitle="Upgrade to open every problem" />
                    <div style={{ flex: 1, overflow: 'auto' }}>
                        <LockedPanel
                            title="This problem needs a Pro plan"
                            subtitle="Upgrade to open every low-level design problem."
                        />
                    </div>
                </div>
            </>
        )
    }

    if (!problem) {
        return (
            <>
                <Navbar />
                <div style={{ paddingTop: "calc(var(--nav-h) + 16px)" }}>
                    <EmptyState
                        art="code"
                        tone="attention"
                        title="Problem not found."
                        action={<Button to="/lld" icon={ChevronLeft}>Back to {TERMS.lld.one}</Button>}
                    />
                </div>
            </>
        )
    }

    // ── Pane contents ──────────────────────────────────────────────
    const RequirementsPane = (
        <div className="pr-ws-pane">
            <h2 className="pr-ws-h">What to build</h2>
            <CollapsibleMarkdown className="markdown-body pr-md">{problem.requirements || '_No requirements yet._'}</CollapsibleMarkdown>

            {/* Notes */}
            <Expander title="Your notes" meta={notesSave === 'saved' && !notesOpen ? 'Saved' : undefined} defaultOpen={!!notesText}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: 8 }}>
                    {notesOpen ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            {notesSave === 'error' && <span role="alert" style={{ fontSize: '0.66rem', color: 'var(--red)' }}>Save failed</span>}
                            <Button
                                variant="warm"
                                busy={notesSave === 'saving'}
                                busyLabel="Saving…"
                                onClick={() => {
                                    setNotesSave('saving')
                                    saveNotes(problem.id, notesText)
                                        .then(() => { setNotesSave('saved'); setNotesOpen(false) })
                                        .catch(() => setNotesSave('error'))
                                }}>
                                {notesSave === 'error' ? 'Retry' : 'Save'}
                            </Button>
                        </span>
                    ) : null}
                </div>
                {notesOpen ? (
                    <textarea
                        value={notesText}
                        onChange={e => setNotesText(e.target.value)}
                        placeholder="Your approach, patterns used, time complexity…"
                        rows={5}
                        className="pr-ta"
                        aria-label="Approach notes"
                        autoFocus
                    />
                ) : (
                    <button type="button" className="pr-note-btn" onClick={() => { setNotesSave('idle'); setNotesOpen(true) }}>
                        {notesText || '+ Add your notes'}
                    </button>
                )}
            </Expander>
        </div>
    )

    const DiagramPane = (
        <div style={{ height: '100%', overflow: 'hidden', position: 'relative' }}>
            <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 10, display: 'flex', gap: 6 }}>
                <span style={{ fontSize: '0.6rem', fontWeight: 900, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', alignSelf: 'center' }}>UML</span>
                {diagrams[0]?.original_url && (
                    <a href={diagrams[0].original_url} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: '0.65rem', padding: '3px 8px', background: 'var(--subtle)', border: '1px solid var(--subtle-strong)', borderRadius: 4, color: 'var(--accent)', textDecoration: 'none' }}>
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
                <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--faint)', fontSize: '0.8rem' }}>
                    No diagram available
                </div>
            )}
        </div>
    )

    const CodePane = (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
            {/* Toolbar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderBottom: '1px solid var(--subtle)', background: 'var(--surface-2)', flexShrink: 0 }}>
                <span style={{ fontSize: '0.6rem', fontWeight: 900, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    {codeFiles.length} files
                </span>
                <div style={{ flex: 1 }} />
                <Button onClick={copyFile} disabled={!activeFile}
                    variant={copyMsg === 'Copy failed' ? 'danger' : 'secondary'}
                    icon={copyMsg && copyMsg !== 'Copy failed' ? Check : Copy}>
                    <span aria-live="polite">{copyMsg || 'Copy'}</span>
                </Button>
                <Button onClick={downloadZip} disabled={!codeFiles.length} icon={Download} aria-label="Download ZIP">
                    ZIP
                </Button>
                {LLD_RUNNER_ENABLED && <Button
                    variant="primary"
                    icon={Play}
                    busy={runStatus === 'running'}
                    busyLabel="Running…"
                    onClick={async () => {
                        if (!codeFiles.length || runStatus === 'running') return
                        setRunStatus('running')
                        setRunResult(null)
                        setShowConsole(true)
                        try {
                            // Detect dominant language from file extensions
                            const extCount = {}
                            codeFiles.forEach(f => {
                                const ext = extOf(f.filepath || f.filename || '')
                                extCount[ext] = (extCount[ext] || 0) + 1
                            })
                            const dominantExt = Object.entries(extCount).sort((a, b) => b[1] - a[1])[0]?.[0] || 'java'
                            const lang = EXT_LANG[dominantExt] || 'java'

                            // Build files list
                            let files = codeFiles.map(f => ({
                                name: (f.filepath || f.filename || '').split('/').pop(),
                                content: f.content || '',
                            }))

                            if (lang === 'java') {
                                // Find file containing main() in any form
                                const mainRe = /(?:public\s+static|static\s+public)\s+(?:final\s+)?void\s+main\s*\(/
                                const mainIdx = files.findIndex(f => mainRe.test(f.content))
                                if (mainIdx >= 0) {
                                    const [mainFile] = files.splice(mainIdx, 1)
                                    // Piston requires filename == public class name for Java
                                    // Extract the public class name from the file
                                    const classMatch = mainFile.content.match(/public\s+class\s+(\w+)/)
                                    if (classMatch) {
                                        mainFile.name = classMatch[1] + '.java'
                                    }
                                    files.unshift(mainFile)
                                }
                                // Also fix class names for other files so they compile
                                files = files.map((f, i) => {
                                    if (i === 0) return f // main file already handled
                                    const cm = f.content.match(/public\s+class\s+(\w+)/)
                                    return cm ? { ...f, name: cm[1] + '.java' } : f
                                })
                            } else if (lang === 'python') {
                                const mainIdx = files.findIndex(f => f.content.includes('if __name__'))
                                if (mainIdx > 0) {
                                    const [mainFile] = files.splice(mainIdx, 1)
                                    files.unshift(mainFile)
                                }
                            } else if (lang === 'csharp') {
                                // For C#: find file with static void Main or top-level statements
                                const mainIdx = files.findIndex(f =>
                                    /static\s+(?:async\s+)?(?:void|Task)\s+Main\s*\(/.test(f.content) ||
                                    f.content.includes('Console.WriteLine') // top-level
                                )
                                if (mainIdx > 0) {
                                    const [mainFile] = files.splice(mainIdx, 1)
                                    files.unshift(mainFile)
                                }
                            }

                            let data
                            try {
                                data = await apiFetch('/api/run', {
                                    json: { language: lang, version: '*', files },
                                    timeout: 60_000,
                                })
                            } catch (err) {
                                data = {
                                    message:
                                        err instanceof ApiError
                                            ? err.body?.message || err.message
                                            : err?.message || 'Code execution failed.',
                                }
                            }
                            if (data.message) {
                                // API-level error (e.g. no API key, unsupported language)
                                setRunResult({ apiError: data.message })
                            } else {
                                setRunResult({
                                    run: data.run ?? null,
                                    compile: data.compile ?? null,
                                    apiError: null,
                                })
                            }
                        } catch (e) {
                            setRunResult({ run: { stdout: '', stderr: e.message, code: 1 }, compile: null, apiError: null })
                        } finally {
                            setRunStatus('done')
                        }
                    }}
                    disabled={!codeFiles.length}
                >
                    Run
                </Button>}
            </div>

            {/* File tabs */}
            {openFiles.length > 0 && (
                <div style={{ display: 'flex', overflowX: 'auto', background: 'var(--surface-2)', borderBottom: '1px solid var(--subtle)', flexShrink: 0 }}>
                    {openFiles.map(f => {
                        const fname = (f.filepath || f.filename || '').split('/').pop()
                        const isActive = activeFile?.id === f.id
                        return (
                            <div key={f.id} onClick={() => setActiveFile(f)} style={{
                                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
                                cursor: 'pointer', flexShrink: 0, borderRight: '1px solid var(--subtle)',
                                background: isActive ? 'var(--panel)' : 'transparent',
                                borderBottom: isActive ? '2px solid var(--warm)' : '2px solid transparent',
                                color: isActive ? 'var(--bright)' : 'var(--muted)', fontSize: '0.75rem',
                                transition: 'color 0.15s',
                            }}>
                                <span style={{ flexShrink: 0 }}>{iconOf(fname)}</span>
                                <span style={{ whiteSpace: 'nowrap' }}>{fname}</span>
                                <button type="button" aria-label={`Close ${fname}`} onClick={(e) => { e.stopPropagation(); closeFile(f.id) }}
                                    style={{ background: 'none', border: 'none', color: 'var(--faint)', cursor: 'pointer', fontSize: 13, padding: '0 2px', lineHeight: 1, marginLeft: 2 }}>
                                    ×
                                </button>
                            </div>
                        )
                    })}
                </div>
            )}

            {/* Editor area — file tree is a left column on desktop, a collapsible top strip on mobile */}
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: isMobile ? 'column' : 'row' }}>
                {/* File tree */}
                <div style={{
                    width: isMobile ? '100%' : 200,
                    borderRight: isMobile ? 'none' : '1px solid var(--subtle)',
                    borderBottom: isMobile ? '1px solid var(--subtle)' : 'none',
                    maxHeight: isMobile ? (treeOpen ? '45vh' : 40) : 'none',
                    overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain',
                    background: 'var(--surface-2)', flexShrink: 0,
                }}>
                    {isMobile && (
                        <button type="button" aria-expanded={treeOpen} onClick={() => setTreeOpen(o => !o)} style={{
                            width: '100%', minHeight: 40, display: 'flex', alignItems: 'center', gap: 6, padding: '9px 12px',
                            border: 'none', color: 'var(--accent)', cursor: 'pointer',
                            fontSize: '0.7rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.06em',
                            position: 'sticky', top: 0, background: 'var(--surface-2)',
                        }}>
                            <span style={{ fontSize: '0.6rem' }}>{treeOpen ? '▼' : '▶'}</span>
                            <span style={{ flexShrink: 0 }}>📁 Files ({codeFiles.length})</span>
                            {activeFile && (
                                <span style={{ marginLeft: 'auto', minWidth: 0, color: 'var(--warm)', fontWeight: 700, textTransform: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '42%' }}>
                                    {(activeFile.filepath || activeFile.filename || '').split('/').pop()}
                                </span>
                            )}
                        </button>
                    )}
                    {!isMobile && codeFiles.length > 0 && openFiles.length <= 1 && (
                        <div style={{
                            display: 'flex', alignItems: 'center', gap: 5,
                            padding: '8px 10px 6px', color: 'var(--faint)', fontSize: '0.68rem',
                            borderBottom: '1px solid var(--panel)',
                        }}>
                            <span aria-hidden style={{ fontSize: '0.74rem' }}>👆</span>
                            <span>Click a file to open</span>
                        </div>
                    )}
                    {(!isMobile || treeOpen) && (
                        codeFiles.length === 0 ? (
                            <div style={{ padding: 12, color: 'var(--faint)', fontSize: '0.72rem' }}>No code files</div>
                        ) : (
                            <FileTree
                                node={fileTree}
                                onOpen={(f) => { openFile(f); if (isMobile) setTreeOpen(false) }}
                                openFiles={openFiles}
                                activeFile={activeFile}
                            />
                        )
                    )}
                </div>

                {/* Monaco + Console */}
                <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
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
                                    automaticLayout: true,
                                    minimap: { enabled: !isMobile },
                                    fontSize: isMobile ? 12 : 13,
                                    lineNumbers: 'on',
                                    scrollBeyondLastLine: false,
                                    wordWrap: isMobile ? 'on' : 'off',
                                    renderWhitespace: 'selection',
                                    folding: true,
                                    bracketPairColorization: { enabled: true },
                                    scrollbar: { alwaysConsumeMouseWheel: false },
                                }}
                            />
                        ) : (
                            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--faint)', gap: 8 }}>
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                                <span style={{ fontSize: '0.78rem' }}>Select a file from the tree</span>
                            </div>
                        )}
                    </div>
                    {LLD_RUNNER_ENABLED && showConsole && (
                        <ConsolePanel
                            run={runResult?.run}
                            compile={runResult?.compile}
                            apiError={runResult?.apiError}
                            status={runStatus}
                            onClose={() => { setShowConsole(false); setRunStatus('idle'); setRunResult(null) }}
                        />
                    )}
                </div>
            </div>
        </div>
    )

    // Only show the Class Diagram pane once the query has resolved AND there's
    // actually a diagram. While the query is still in flight, treat as no diagram
    // (Requirements fills the pane) — a late-arriving diagram slots it in.
    const hasDiagram = diagramsFetched && diagrams.length > 0

    // Mobile tab set depends on whether the diagram pane exists.
    const mobileTabs = hasDiagram ? ['requirements', 'diagram', 'code'] : ['requirements', 'code']
    const activeMobileTab = mobileTabs.includes(mobileTab) ? mobileTab : 'requirements'

    return (
        <>
            <Navbar />
            <div className="pr-ws">
                {/* Compact header: back · title · difficulty · practised toggle; small pane tabs on phones */}
                <div className="pr-ws-top">
                    <PageHeader
                        section="prepare"
                        className="pr-ws-ph"
                        back={{ to: '/lld', label: TERMS.lld.one }}
                        title={problem.title}
                        subtitle={null}
                        aside={problem.difficulty ? <DifficultyBadge difficulty={problem.difficulty} /> : null}
                        action={
                            <label className="pr-done">
                                <FluidCheckbox
                                    checked={isSolved}
                                    label={isSolved ? 'Mark as not practised' : 'Mark as practised'}
                                    onChange={() => {
                                        if (prog?.status !== 'solved') {
                                            track(EVENTS.QUESTION_COMPLETED, { type: 'lld', problem_id: problem.id })
                                        }
                                        toggleStatus(problem.id, prog?.status ?? 'unsolved')
                                    }}
                                />
                                <span aria-hidden="true">{isSolved ? 'Practised' : 'Mark done'}</span>
                            </label>
                        }
                    />
                    {isMobile && (
                        <SmallTabs idPrefix="lld" label="Problem panes" section="prepare" value={activeMobileTab} onChange={setMobileTab} block
                            items={mobileTabs.map(t => ({ value: t, label: MOBILE_TAB_LABEL[t] || t }))} />
                    )}
                </div>

                {/* Workspace: 3-pane on desktop, tabbed on mobile.
                    (Free-tier deep-links are handled by the `locked` early return.) */}
                {!isMobile ? (
                    <Group orientation="horizontal" style={{ flex: 1, overflow: 'hidden' }}>
                        {/* Left pane: requirements (top) + diagram (bottom) — or just
                            requirements full-height when there's no class diagram. */}
                        <Panel defaultSize="35" minSize="20" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                            {hasDiagram ? (
                                <Group orientation="vertical" style={{ flex: 1 }}>
                                    <Panel defaultSize="55" minSize="20" style={{ overflow: 'hidden', background: 'var(--surface-2)' }}>
                                        {RequirementsPane}
                                    </Panel>
                                    <Separator className="rrp-sep" style={{ height: 6, background: 'var(--subtle)' }} />
                                    <Panel defaultSize="45" minSize="15" style={{ overflow: 'hidden', background: 'var(--surface-2)' }}>
                                        {DiagramPane}
                                    </Panel>
                                </Group>
                            ) : (
                                <div style={{ flex: 1, overflow: 'hidden', background: 'var(--surface-2)' }}>
                                    {RequirementsPane}
                                </div>
                            )}
                        </Panel>

                        <Separator className="rrp-sep" style={{ width: 6, background: 'var(--subtle)' }} />

                        {/* Right pane: code viewer */}
                        <Panel defaultSize="65" minSize="30" style={{ overflow: 'hidden' }}>
                            {CodePane}
                        </Panel>
                    </Group>
                ) : (
                    // Mobile: tab view
                    <div role="tabpanel" id={`lld-panel-${activeMobileTab}`} aria-labelledby={`lld-tab-${activeMobileTab}`} style={{ flex: 1, overflow: 'hidden' }}>
                        {activeMobileTab === 'requirements' && <div style={{ height: '100%', overflow: 'auto', background: 'var(--surface-2)' }}>{RequirementsPane}</div>}
                        {activeMobileTab === 'diagram' && hasDiagram && <div style={{ height: '100%', overflow: 'hidden', background: 'var(--surface-2)' }}>{DiagramPane}</div>}
                        {activeMobileTab === 'code' && <div style={{ height: '100%', overflow: 'hidden' }}>{CodePane}</div>}
                    </div>
                )}
            </div>
        </>
    )
}

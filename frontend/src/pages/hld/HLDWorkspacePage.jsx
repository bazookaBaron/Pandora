import { useState, useCallback, useRef, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import ReactFlow, {
    addEdge, MiniMap, Controls, Background,
    useNodesState, useEdgesState, ReactFlowProvider,
    Handle, Position, BaseEdge, EdgeLabelRenderer, getBezierPath,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { useProgress } from '../../lib/useProgress'
import { useAuth } from '../../contexts/AuthContext'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { apiFetch, ApiError, isUsageLimit } from '../../lib/apiClient'
import { LockedPanel } from '../../components/shared/PaywallGate'
import { LoadingState, ErrorState, EmptyState, LimitReached } from '../../components/shared/states'
import { track, EVENTS } from '../../lib/analytics'
import Navbar from '../../components/Navbar'
import DifficultyBadge from '../../components/shared/DifficultyBadge'
import { Button, SmallTabs, EmptyArt, PageHeader } from '../../components/ui'
import CollapsibleMarkdown, { Expander } from '../../components/interview/CollapsibleMarkdown'
import { track as trackUi, TRACK } from '../../lib/track'
import { TERMS } from '../../lib/copy'
import { ChevronLeft, Scale, RotateCcw, Plus, X, Trash2, ThumbsUp, Wrench } from 'lucide-react'

// ── Node palette config ──────────────────────────────────────────────
const NODE_TYPES_CONFIG = [
    // Original 10
    { type: 'client', label: 'Client', emoji: '💻', color: '#22d3ee' },
    { type: 'server', label: 'Server', emoji: '⚙️', color: '#f472b6' },
    { type: 'database', label: 'Database', emoji: '🗄️', color: '#4ade80' },
    { type: 'cache', label: 'Cache', emoji: '⚡', color: '#facc15' },
    { type: 'queue', label: 'Queue', emoji: '📬', color: '#fb923c' },
    { type: 'cdn', label: 'CDN', emoji: '🌐', color: '#a78bfa' },
    { type: 'lb', label: 'Load Balancer', emoji: '⚖️', color: '#60a5fa' },
    { type: 'gateway', label: 'API Gateway', emoji: '🚪', color: '#f87171' },
    { type: 'storage', label: 'Storage', emoji: '🪣', color: '#34d399' },
    { type: 'service', label: 'Microservice', emoji: '🔷', color: '#818cf8' },
    // New 10
    { type: 'sns', label: 'SNS', emoji: '📣', color: '#fb923c' },
    { type: 'sqs', label: 'SQS', emoji: '📮', color: '#fbbf24' },
    { type: 'kafka', label: 'Kafka', emoji: '🌊', color: '#60a5fa' },
    { type: 'custom', label: 'Custom Service', emoji: '🔧', color: '#94a3b8' },
    { type: 'auth', label: 'Auth Service', emoji: '🔐', color: '#f472b6' },
    { type: 'ratelimiter', label: 'Rate Limiter', emoji: '🚦', color: '#f87171' },
    { type: 'search', label: 'Search Index', emoji: '🔍', color: '#a78bfa' },
    { type: 'objstore', label: 'Object Store', emoji: '🗃️', color: '#34d399' },
    { type: 'worker', label: 'Consumer/Worker', emoji: '👷', color: '#e879f9' },
    { type: 'cdnedge', label: 'CDN Edge', emoji: '🌍', color: '#38bdf8' },
]

// ── Custom HLD Node (with Handles + Delete button + Inline Rename) ───
function HLDNode({ id, data, selected }) {
    const [editing, setEditing] = useState(false)
    const [editValue, setEditValue] = useState(data.label || '')

    const commitRename = useCallback(() => {
        setEditing(false)
        if (editValue.trim() && editValue.trim() !== data.label) {
            // Propagate new label up via the data.onRename callback
            data.onRename?.(id, editValue.trim())
        }
    }, [editValue, data, id])

    const handleKeyDown = useCallback((e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitRename() }
        if (e.key === 'Escape') { setEditing(false); setEditValue(data.label || '') }
    }, [commitRename, data.label])

    return (
        <div
            style={{
                padding: '8px 14px', borderRadius: 8,
                background: 'var(--panel)', border: `2px solid ${selected ? '#fff' : (data.color || 'var(--subtle-strong)')}`,
                color: 'var(--bright)', fontSize: '0.78rem', fontWeight: 700,
                display: 'flex', alignItems: 'center', gap: 6,
                boxShadow: `0 0 12px ${data.color || '#3f3f46'}33`,
                minWidth: 100, cursor: 'default', position: 'relative',
                userSelect: 'none',
            }}
            onDoubleClick={(e) => {
                // Allow rename on any custom-type node
                if (data.renameable) {
                    e.stopPropagation()
                    setEditValue(data.label || '')
                    setEditing(true)
                }
            }}
        >
            {/* Connection handles — isConnectable=true allows many-to-many */}
            <Handle
                type="target"
                position={Position.Left}
                isConnectable={true}
                style={{ background: '#a78bfa', border: '2px solid #7c3aed', width: 10, height: 10 }}
            />
            <span>{data.emoji}</span>
            {editing ? (
                <input
                    autoFocus
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={handleKeyDown}
                    onClick={e => e.stopPropagation()}
                    className="nodrag"
                    style={{
                        background: 'transparent', border: 'none', borderBottom: '1px solid #a78bfa',
                        color: 'var(--bright)', font: 'inherit', fontSize: '0.78rem', fontWeight: 700,
                        outline: 'none', width: 100, padding: '0 2px',
                    }}
                />
            ) : (
                <span>{data.label}</span>
            )}
            <Handle
                type="source"
                position={Position.Right}
                isConnectable={true}
                style={{ background: '#22d3ee', border: '2px solid #0891b2', width: 10, height: 10 }}
            />
            {/* × Delete button — visible on hover/select */}
            {selected && (
                <button
                    onClick={(e) => { e.stopPropagation(); data.onDelete?.(id) }}
                    className="nodrag nopan"
                    style={{
                        position: 'absolute', top: -8, right: -8,
                        width: 18, height: 18, borderRadius: '50%',
                        background: '#f87171', border: '2px solid var(--surface)',
                        color: '#fff', cursor: 'pointer', fontSize: '0.55rem',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        padding: 0, lineHeight: 1, fontWeight: 900,
                        zIndex: 10,
                    }}
                    title="Delete node"
                >×</button>
            )}
        </div>
    )
}

// ── Custom Edge with label + style toggle ─────────────────────────────
function CustomEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }) {
    const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
    const isDashed = data?.style === 'dashed'
    return (
        <>
            <BaseEdge
                path={edgePath}
                markerEnd={markerEnd}
                style={{
                    stroke: selected ? '#fff' : (isDashed ? '#fb923c' : '#a78bfa'),
                    strokeWidth: selected ? 2.5 : 1.8,
                    strokeDasharray: isDashed ? '6 3' : undefined,
                }}
            />
            {data?.label && (
                <EdgeLabelRenderer>
                    <div
                        style={{
                            position: 'absolute',
                            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
                            pointerEvents: 'all',
                            fontSize: '0.58rem', fontWeight: 700,
                            background: 'var(--panel)', border: '1px solid var(--subtle-strong)',
                            padding: '1px 5px', borderRadius: 3, color: 'var(--accent)',
                            whiteSpace: 'nowrap',
                        }}
                        className="nodrag nopan"
                    >
                        {data.label}
                    </div>
                </EdgeLabelRenderer>
            )}
        </>
    )
}

const nodeTypes = { hldNode: HLDNode }
const edgeTypes = { custom: CustomEdge }

let nodeId = 100
const nextId = () => `n${++nodeId}`

// ── Score Ring ───────────────────────────────────────────────────────
function ScoreRing({ score }) {
    const r = 38, circ = 2 * Math.PI * r
    const offset = circ * (1 - score / 100)
    const color = score >= 70 ? 'var(--sys-success)' : score >= 40 ? 'var(--sys-waiting)' : 'var(--sys-danger)'
    return (
        <div style={{ position: 'relative', width: 90, height: 90, flexShrink: 0 }}>
            <svg width="90" height="90" viewBox="0 0 90 90" style={{ transform: 'rotate(-90deg)' }}>
                <circle cx="45" cy="45" r={r} fill="none" style={{ stroke: 'var(--subtle)' }} strokeWidth="6" />
                <circle cx="45" cy="45" r={r} fill="none" strokeWidth="6"
                    strokeDasharray={circ} strokeDashoffset={offset}
                    style={{ stroke: color, transition: 'stroke-dashoffset 1s ease' }} />
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: '1.1rem', fontWeight: 900, color }}>{score}</span>
                <span style={{ fontSize: '0.55rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>/100</span>
            </div>
        </div>
    )
}

// ── API Endpoint Designer ─────────────────────────────────────────────
function ApiEndpointDesigner({ endpoints, onChange }) {
    const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
    const METHOD_COLORS = { GET: 'var(--sys-success)', POST: 'var(--sys-active)', PUT: 'var(--sys-waiting)', PATCH: 'var(--sys-attention)', DELETE: 'var(--sys-danger)' }
    const addRow = () => onChange([...endpoints, { method: 'GET', path: '', description: '' }])
    const update = (i, field, value) => { const next = [...endpoints]; next[i] = { ...next[i], [field]: value }; onChange(next) }
    const remove = (i) => onChange(endpoints.filter((_, idx) => idx !== i))
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {endpoints.map((ep, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '76px 1fr auto', gap: 5, alignItems: 'center' }}>
                    <select aria-label="HTTP method" value={ep.method} onChange={e => update(i, 'method', e.target.value)}
                        style={{ padding: '3px 4px', background: 'var(--panel)', border: `1px solid color-mix(in srgb, ${METHOD_COLORS[ep.method]} 30%, transparent)`, borderRadius: 4, color: METHOD_COLORS[ep.method], font: 'inherit', fontSize: '0.65rem', fontWeight: 900, outline: 'none', cursor: 'pointer' }}>
                        {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <input aria-label="Endpoint path" value={ep.path} onChange={e => update(i, 'path', e.target.value)}
                        placeholder="/api/resource"
                        style={{ padding: '3px 6px', background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 4, color: 'var(--bright)', font: 'inherit', fontSize: '0.72rem', outline: 'none' }} />
                    <Button variant="ghost" iconOnly icon={X} aria-label="Remove endpoint" onClick={() => remove(i)} />
                </div>
            ))}
            <Button icon={Plus} onClick={addRow} style={{ alignSelf: 'flex-start', marginTop: 2 }}>Endpoint</Button>
        </div>
    )
}

// ── Capacity Estimation Tab ───────────────────────────────────────────
function CapacityEstimator({ value, onChange }) {
    const v = value || { dau: 1, qps: 100, storagePerDayGB: 1, replication: 3, instanceCostPerMonth: 50, instanceCount: 2, notes: '' }
    const set = (field, val) => onChange({ ...v, [field]: val })
    const totalStorageGB = v.storagePerDayGB * 365 * v.replication
    const totalCost = v.instanceCount * v.instanceCostPerMonth
    const inputStyle = { padding: '4px 8px', background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 4, color: 'var(--bright)', font: 'inherit', fontSize: '0.75rem', outline: 'none', width: '100%' }
    const label = (txt) => <label style={{ fontSize: '0.6rem', fontWeight: 900, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em', display: 'block', marginBottom: 4, marginTop: 10 }}>{txt}</label>
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {label('DAU (millions)')}
            <input type="number" value={v.dau} onChange={e => set('dau', +e.target.value)} style={inputStyle} />
            {label('Avg QPS')}
            <input type="number" value={v.qps} onChange={e => set('qps', +e.target.value)} style={inputStyle} />
            {label('Storage / Day (GB)')}
            <input type="number" value={v.storagePerDayGB} onChange={e => set('storagePerDayGB', +e.target.value)} style={inputStyle} />
            {label('Replication Factor')}
            <input type="number" value={v.replication} onChange={e => set('replication', +e.target.value)} style={inputStyle} />
            {label('Instance Count')}
            <input type="number" value={v.instanceCount} onChange={e => set('instanceCount', +e.target.value)} style={inputStyle} />
            {label('$/Month per Instance')}
            <input type="number" value={v.instanceCostPerMonth} onChange={e => set('instanceCostPerMonth', +e.target.value)} style={inputStyle} />

            {/* Estimates */}
            <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: '0.6rem', fontWeight: 900, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Estimates</span>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem' }}>
                    <span style={{ color: 'var(--muted)' }}>Yearly storage (with replication)</span>
                    <span style={{ color: 'var(--sys-success)', fontWeight: 700 }}>{totalStorageGB.toFixed(0)} GB</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem' }}>
                    <span style={{ color: 'var(--muted)' }}>Monthly infra cost</span>
                    <span style={{ color: 'var(--sys-waiting)', fontWeight: 700 }}>${totalCost.toFixed(0)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem' }}>
                    <span style={{ color: 'var(--muted)' }}>Peak QPS burst (10×)</span>
                    <span style={{ color: 'var(--sys-danger)', fontWeight: 700 }}>{(v.qps * 10).toLocaleString()}</span>
                </div>
            </div>

            {label('Notes / Assumptions')}
            <textarea value={v.notes} onChange={e => set('notes', e.target.value)}
                placeholder="Cache hit rate assumptions, SLA requirements, CDN offload…"
                rows={4}
                style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }} />
        </div>
    )
}

// ── Edge Selection Toolbar ────────────────────────────────────────────
function EdgeToolbar({ edge, onUpdate, onDelete }) {
    if (!edge) return null
    return (
        <div style={{
            position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 20,
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
            background: 'var(--nav-bg)', border: '1px solid var(--subtle-strong)', borderRadius: 8,
            backdropFilter: 'blur(8px)', boxShadow: '0 4px 20px rgba(0,0,0,0.35)',
        }}>
            <span style={{ fontSize: '0.6rem', fontWeight: 900, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Edge:</span>
            <input
                value={edge.data?.label || ''}
                onChange={e => onUpdate(edge.id, { label: e.target.value })}
                placeholder="Label…"
                aria-label="Edge label"
                style={{ padding: '3px 7px', background: 'var(--panel)', border: '1px solid var(--subtle)', borderRadius: 4, color: 'var(--bright)', font: 'inherit', fontSize: '0.72rem', outline: 'none', width: 120 }}
            />
            <button
                onClick={() => onUpdate(edge.id, { style: edge.data?.style === 'dashed' ? 'solid' : 'dashed' })}
                style={{ padding: '3px 9px', borderRadius: 4, border: '1px solid var(--subtle-strong)', background: 'none', cursor: 'pointer', fontSize: '0.68rem', fontWeight: 700, color: edge.data?.style === 'dashed' ? 'var(--sys-attention)' : 'var(--sys-plan)' }}
            >
                {edge.data?.style === 'dashed' ? '- - Async' : '— Sync'}
            </button>
            <Button variant="danger" iconOnly icon={Trash2} aria-label="Delete edge" onClick={() => onDelete(edge.id)} />
        </div>
    )
}

// ── Main Component ───────────────────────────────────────────────────
function HLDWorkspaceInner() {
    const { id } = useParams()
    const { user } = useAuth()
    const isMobile = useMediaQuery('(max-width: 767px)')
    const { progressMap, saveNotes, isSuccess: progressLoaded } = useProgress('hld')

    // Mobile single-pane switcher: 'brief' | 'canvas' | 'judge'. Opens on the
    // brief so phones see a short summary before the tools.
    const [mobilePane, setMobilePane] = useState('brief')
    const [paletteOpen, setPaletteOpen] = useState(false)

    const [nodes, setNodes, onNodesChange] = useNodesState([])
    const [edges, setEdges, onEdgesChange] = useEdgesState([])
    const [rfInstance, setRfInstance] = useState(null)
    const [selectedEdge, setSelectedEdge] = useState(null)
    const canvasRef = useRef(null)

    // Left panel tabs: 'req' | 'api' | 'capacity'
    const [activeLeftTab, setActiveLeftTab] = useState('req')
    const [frNfr, setFrNfr] = useState({ fr: '', nfr: '' })
    const [frNfrLoading, setFrNfrLoading] = useState(false)
    const [endpoints, setEndpoints] = useState([])
    const [capacity, setCapacity] = useState(null)
    const [notesText, setNotesText] = useState('')

    const [judgeResult, setJudgeResult] = useState(null)
    const [judging, setJudging] = useState(false)
    // Set when /api/hld/generate or /api/hld/judge returns a usage-limit error —
    // { used, limit, resetsAt }. Drives an inline "monthly limit reached" note.
    const [usageLimitInfo, setUsageLimitInfo] = useState(null)
    const saveTimer = useRef(null)
    // autosave status chip: 'idle' | 'saving' | 'saved' | 'error'
    const [saveState, setSaveState] = useState('idle')
    const lastStateRef = useRef(null)

    // Hydration guards: nothing is persisted until the saved row (if any) has
    // been applied once, and the load effect only ever hydrates a single time
    // per mount so it can't clobber in-progress user edits.
    const hydratedRef = useRef(false)
    const viewportAppliedRef = useRef(false)
    // State mirror of hydratedRef purely so the "restoring" hint re-renders away
    // once hydration completes even when there was no saved row to apply.
    const [hydrated, setHydrated] = useState(false)

    // ── Authenticated detail fetch ──────────────────────────────────────
    // The server gates this on `hld_practice`: free users are always 403
    // (upgrade_required); pro users who spent their monthly 5 also 403. No tier
    // math on the client — `tierLocked` is derived straight from that response.
    const { data, isLoading, isError, error } = useQuery({
        queryKey: ['catalog-hld-detail', id],
        queryFn: () => apiFetch('/api/catalog/hld/' + id),
        enabled: !!id,
        staleTime: 5 * 60_000, // problem content is static; was refetching on every mount
        retry: (count, err) => !(err instanceof ApiError) && count < 2,
    })
    const problem = data?.item || null

    const tierLocked = isError && error instanceof ApiError && error.code === 'upgrade_required'

    // QUESTION_STARTED once per (non-locked) problem. Keyed on problem id so
    // navigating to another question re-arms it; StrictMode-safe.
    const questionStartedRef = useRef(null)
    useEffect(() => {
        if (tierLocked || !problem?.id) return
        if (questionStartedRef.current === problem.id) return
        questionStartedRef.current = problem.id
        track(EVENTS.QUESTION_STARTED, { type: 'hld', problem_id: problem.id })
    }, [problem?.id, tierLocked])

    const prog = problem ? progressMap[problem.id] : null

    // Load saved state — once, after the progress rows have actually loaded for
    // this signed-in user. `useProgress` gates its query with `enabled: !!user`,
    // and react-query reports `isLoading === false` for a disabled query — so a
    // cold load where `getSession()` hasn't resolved yet (user still null) would
    // otherwise mark hydration done against an empty map and permanently block
    // the real saved row when it arrives. Gate on user + progressLoaded instead.
    // With progressLoaded true, `prog === undefined` legitimately means "no saved
    // row" → we still mark hydrated so first-time users can start persisting.
    useEffect(() => {
        if (hydratedRef.current || !user || !progressLoaded || !problem) return
        const s = prog?.state
        if (s) {
            if (s.nodes) setNodes(s.nodes)
            if (s.edges) setEdges(s.edges)
            if (s.viewport && rfInstance) { rfInstance.setViewport(s.viewport); viewportAppliedRef.current = true }
            if (s.frNfr) setFrNfr(s.frNfr)
            if (s.endpoints) setEndpoints(s.endpoints)
            if (s.capacity) setCapacity(s.capacity)
            if (typeof s.notes === 'string') setNotesText(s.notes)
        }
        hydratedRef.current = true
        setHydrated(true)
    }, [user, progressLoaded, problem?.id, prog?.id, rfInstance])

    // If rfInstance mounts after hydration ran, apply the saved viewport once.
    useEffect(() => {
        if (rfInstance && prog?.state?.viewport && !viewportAppliedRef.current) {
            rfInstance.setViewport(prog.state.viewport)
            viewportAppliedRef.current = true
        }
    }, [rfInstance, prog?.id])

    // Auto-generate FR/NFR on first visit — only after saved progress has loaded
    // and been applied (otherwise we'd burn a metered AI call and overwrite a
    // saved FR/NFR). The route is keyed by problem id (App.jsx) so hydratedRef /
    // viewportAppliedRef reset on every problem change via remount.
    useEffect(() => {
        if (!problem || tierLocked || !progressLoaded || !hydrated || frNfr.fr || frNfrLoading) return
        if (prog?.state?.frNfr?.fr) return
        setFrNfrLoading(true)
        apiFetch('/api/hld/generate', { json: { description: problem.description || problem.title }, timeout: 120_000 })
            .then(d => { if (d?.fr) setFrNfr({ fr: d.fr, nfr: d.nfr || '' }) })
            .catch(err => {
                if (isUsageLimit(err)) setUsageLimitInfo({ used: err.used, limit: err.limit, resetsAt: err.resetsAt })
            })
            .finally(() => setFrNfrLoading(false))
    }, [problem?.id, progressLoaded, hydrated, tierLocked])

    // Persist state (debounced)
    const persistState = useCallback(() => {
        if (!problem || tierLocked) return
        if (!hydratedRef.current) return   // don't write until the initial hydrate has happened
        clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => {
            if (!hydratedRef.current) return
            const state = {
                ...(rfInstance ? rfInstance.toObject() : { nodes, edges }),   // { nodes, edges, viewport }
                frNfr, endpoints, capacity, notes: notesText,
            }
            // notes:undefined -> leave the dedicated `notes` column untouched;
            // the real notes travel inside state.notes.
            lastStateRef.current = { id: problem.id, state }
            setSaveState('saving')
            saveNotes(problem.id, undefined, state)
                .then(() => { if (lastStateRef.current?.state === state) setSaveState('saved') })
                .catch(() => { if (lastStateRef.current?.state === state) setSaveState('error') })
        }, 1500)
    }, [problem, tierLocked, nodes, edges, frNfr, endpoints, capacity, notesText, rfInstance])

    useEffect(() => { persistState() }, [nodes, edges, frNfr, endpoints, capacity, notesText])

    const retrySave = () => {
        const last = lastStateRef.current
        if (!last) return
        setSaveState('saving')
        saveNotes(last.id, undefined, last.state)
            .then(() => { if (lastStateRef.current === last) setSaveState('saved') })
            .catch(() => { if (lastStateRef.current === last) setSaveState('error') })
    }

    // Node rename callback — called by HLDNode when user commits an inline rename
    const renameNode = useCallback((nodeId, newLabel) => {
        setNodes(nds => nds.map(n =>
            n.id === nodeId ? { ...n, data: { ...n.data, label: newLabel } } : n
        ))
    }, [])

    // Node delete — removes node + all connected edges
    const deleteNode = useCallback((nodeId) => {
        setNodes(nds => nds.filter(n => n.id !== nodeId))
        setEdges(eds => eds.filter(e => e.source !== nodeId && e.target !== nodeId))
    }, [])

    // Keyboard Delete/Backspace to delete selected nodes
    useEffect(() => {
        const handler = (e) => {
            if (e.key !== 'Delete' && e.key !== 'Backspace') return
            // Don't fire when typing inside inputs/textareas
            const tag = document.activeElement?.tagName
            if (tag === 'INPUT' || tag === 'TEXTAREA') return
            setNodes(nds => {
                const toDelete = new Set(nds.filter(n => n.selected).map(n => n.id))
                if (!toDelete.size) return nds
                setEdges(eds => eds.filter(e => !toDelete.has(e.source) && !toDelete.has(e.target)))
                return nds.filter(n => !toDelete.has(n.id))
            })
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [])

    const onConnect = useCallback((params) =>
        setEdges(eds => addEdge({
            ...params,
            type: 'custom',
            data: { style: 'solid', label: '' },
            markerEnd: { type: 'arrowclosed', color: '#a78bfa' },
        }, eds)), [])

    const onDrop = useCallback((e) => {
        e.preventDefault()
        const typeKey = e.dataTransfer.getData('application/hld-node')
        if (!typeKey || !rfInstance) return
        const cfg = NODE_TYPES_CONFIG.find(n => n.type === typeKey)
        if (!cfg) return
        const rect = e.currentTarget.getBoundingClientRect()
        const pos = rfInstance.screenToFlowPosition({ x: e.clientX - rect.left, y: e.clientY - rect.top })
        setNodes(nds => [...nds, {
            id: nextId(), type: 'hldNode', position: pos,
            data: {
                label: cfg.label, emoji: cfg.emoji, color: cfg.color,
                renameable: cfg.type === 'custom', // only custom service is renameable by default — extend if desired
                onRename: renameNode,
                onDelete: deleteNode,
            },
        }])
    }, [rfInstance, renameNode, deleteNode])

    const onDragOver = useCallback((e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }, [])

    const onEdgeClick = useCallback((_, edge) => setSelectedEdge(edge), [])
    const onPaneClick = useCallback(() => setSelectedEdge(null), [])

    const updateEdge = useCallback((edgeId, dataPatch) => {
        setEdges(eds => eds.map(e => e.id === edgeId ? { ...e, data: { ...e.data, ...dataPatch } } : e))
        setSelectedEdge(prev => prev?.id === edgeId ? { ...prev, data: { ...prev.data, ...dataPatch } } : prev)
    }, [])

    const deleteEdge = useCallback((edgeId) => {
        setEdges(eds => eds.filter(e => e.id !== edgeId))
        setSelectedEdge(null)
    }, [])

    const handleJudge = async () => {
        if (!canvasRef.current || judging) return
        setJudging(true); setJudgeResult(null)
        // On mobile the canvas pane is `display:none` unless it's the active tab,
        // which gives it zero layout size — toPng() then captures nothing and the
        // server rejects the empty image_base64. Force the canvas pane visible
        // for the snapshot, then hop to the Judge pane to show the result.
        const cameFromOtherPane = isMobile && mobilePane !== 'canvas'
        if (cameFromOtherPane) {
            setMobilePane('canvas')
            // Two RAFs for the display:none -> flex layout/paint, plus a beat for
            // React Flow's own resize-observer to re-measure the now-visible pane.
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            await new Promise((resolve) => setTimeout(resolve, 60))
        }
        try {
            const bg = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#09090b'
            const imgData = await (await import('html-to-image')).toPng(canvasRef.current, { backgroundColor: bg, pixelRatio: 1.5 })
            const result = await apiFetch('/api/hld/judge', {
                json: { image_base64: imgData.split(',')[1], frNfr, apiEndpoints: endpoints, title: problem?.title || '' },
                timeout: 120_000,
            })
            setJudgeResult(result)
            if (problem?.id) {
                track(EVENTS.QUESTION_COMPLETED, { type: 'hld', problem_id: problem.id, score: result?.score ?? null })
            }
        } catch (e) {
            if (isUsageLimit(e)) setUsageLimitInfo({ used: e.used, limit: e.limit, resetsAt: e.resetsAt })
            else setJudgeResult({ error: e })
        }
        finally {
            setJudging(false)
            if (cameFromOtherPane) setMobilePane('judge')
        }
    }

    const regenerateFrNfr = () => {
        setFrNfr({ fr: '', nfr: '' }); setFrNfrLoading(true)
        apiFetch('/api/hld/generate', { json: { description: problem.description || problem.title }, timeout: 120_000 })
            .then(d => { if (d?.fr) setFrNfr({ fr: d.fr, nfr: d.nfr || '' }) })
            .catch(err => { if (isUsageLimit(err)) setUsageLimitInfo({ used: err.used, limit: err.limit, resetsAt: err.resetsAt }) })
            .finally(() => setFrNfrLoading(false))
    }

    if (isLoading) return <><Navbar /><div style={{ paddingTop: "calc(var(--nav-h) + 16px)" }}><LoadingState label="Loading…" /></div></>
    if (isError && error?.status === 401) return <><Navbar /><div style={{ paddingTop: "calc(var(--nav-h) + 16px)" }}><ErrorState err={error} /><p style={{ textAlign: 'center', marginTop: 12 }}><Button to="/hld" icon={ChevronLeft}>Back to {TERMS.hld.one}</Button></p></div></>
    // tierLocked (403 upgrade_required) keeps the header bar + a LockedPanel body,
    // handled in the main return below — so don't fall into "not found"/error here.
    if (isError && !tierLocked) return <><Navbar /><div style={{ paddingTop: "calc(var(--nav-h) + 16px)" }}><ErrorState title="Could not load this question." err={error} /><p style={{ textAlign: 'center', marginTop: 12 }}><Button to="/hld" icon={ChevronLeft}>Back to {TERMS.hld.one}</Button></p></div></>
    if (!problem && !tierLocked) return <><Navbar /><div style={{ paddingTop: "calc(var(--nav-h) + 16px)" }}><EmptyState art="diagram" tone="plan" title="Question not found." action={<Button to="/hld" icon={ChevronLeft}>Back to {TERMS.hld.one}</Button>} /></div></>

    // Inline "monthly HLD-practice limit reached" note — shown near the FR/NFR
    // block and the Judge button when /api/hld/generate or /api/hld/judge 402s.
    const usageLimitNote = usageLimitInfo ? (
        <LimitReached
            compact
            feature="hld_practice"
            used={usageLimitInfo.used}
            limit={usageLimitInfo.limit}
            resetsAt={usageLimitInfo.resetsAt}
        />
    ) : null

    const ACCENT = 'var(--sys-plan)'

    // Add a node at the canvas centre — used by the mobile palette (HTML5 drag
    // isn't available on touch, so tapping a chip drops the node instead).
    const addNodeAtCenter = (cfg) => {
        let pos = { x: 160 + Math.random() * 80, y: 120 + Math.random() * 80 }
        if (rfInstance && canvasRef.current) {
            const rect = canvasRef.current.getBoundingClientRect()
            pos = rfInstance.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
        }
        setNodes(nds => [...nds, {
            id: nextId(), type: 'hldNode', position: pos,
            data: {
                label: cfg.label, emoji: cfg.emoji, color: cfg.color,
                renameable: cfg.type === 'custom',
                onRename: renameNode, onDelete: deleteNode,
            },
        }])
    }

    const paletteChip = (cfg) => (
        <div key={cfg.type}
            draggable
            onDragStart={e => e.dataTransfer.setData('application/hld-node', cfg.type)}
            onClick={() => { if (isMobile) addNodeAtCenter(cfg) }}
            style={{
                padding: '3px 7px', borderRadius: 5, border: `1px solid ${cfg.color}44`,
                background: `${cfg.color}15`, color: cfg.color,
                fontSize: '0.62rem', fontWeight: 700, cursor: isMobile ? 'pointer' : 'grab',
                display: 'flex', alignItems: 'center', gap: 3, userSelect: 'none',
                whiteSpace: 'nowrap', flexShrink: 0,
            }}
            title={isMobile ? `Tap to add ${cfg.label}` : `Drag to add ${cfg.label}`}>
            <span>{cfg.emoji}</span>
            <span>{cfg.label}</span>
        </div>
    )

    // ── LEFT PANEL (Requirements / API / Capacity) ───────────────────────
    const leftPanel = (
        <div style={{
            borderRight: isMobile ? 'none' : '1px solid var(--subtle)', display: 'flex', flexDirection: 'column',
            overflow: 'hidden', background: 'var(--surface-2)', ...(isMobile ? { flex: 1, minHeight: 0 } : null),
        }}>
            {/* Tab bar: Requirements | API | Capacity */}
                        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--subtle)', flexShrink: 0, background: 'var(--surface-2)' }}>
                            <SmallTabs idPrefix="hld-brief" label="Brief sections" section="prepare" value={activeLeftTab} onChange={setActiveLeftTab} block
                                items={[{ value: 'req', label: 'Brief' }, { value: 'api', label: 'API' }, { value: 'capacity', label: 'Capacity' }]} />
                        </div>

                        <div role="tabpanel" id={`hld-brief-panel-${activeLeftTab}`} aria-labelledby={`hld-brief-tab-${activeLeftTab}`}
                            style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
                            {/* ── Requirements tab (Notes + FR + NFR merged) ── */}
                            {activeLeftTab === 'req' && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                                    {/* Problem: short summary first, long sections collapsed */}
                                    <div>
                                        <h2 className="pr-ws-h">What to design</h2>
                                        <CollapsibleMarkdown className="markdown-body pr-md">{problem.description || problem.question || problem.title}</CollapsibleMarkdown>
                                    </div>

                                    {/* Notes */}
                                    <Expander title="Your notes" defaultOpen={!!notesText}>
                                        <textarea value={notesText} onChange={e => setNotesText(e.target.value)}
                                            aria-label="Your notes"
                                            placeholder="Jot your approach, trade-offs…"
                                            rows={4}
                                            className="pr-ta" />
                                    </Expander>

                                    {usageLimitNote && <div>{usageLimitNote}</div>}

                                    {/* FR */}
                                    <Expander title="What it must do" meta={frNfrLoading ? 'Writing…' : undefined}>
                                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
                                            <Button variant="ghost" icon={RotateCcw} onClick={regenerateFrNfr} disabled={frNfrLoading}
                                                aria-label="Write the requirements again" title="Write again">Rewrite</Button>
                                        </div>
                                        <textarea value={frNfr.fr} onChange={e => setFrNfr(p => ({ ...p, fr: e.target.value }))}
                                            aria-label="Functional requirements"
                                            placeholder="These fill in by themselves…" rows={6}
                                            className="pr-ta" />
                                    </Expander>

                                    {/* NFR */}
                                    <Expander title="How well it must work" meta={frNfrLoading ? 'Writing…' : undefined}>
                                        <textarea value={frNfr.nfr} onChange={e => setFrNfr(p => ({ ...p, nfr: e.target.value }))}
                                            aria-label="Non-functional requirements"
                                            placeholder="Scale, speed, uptime. Fills in by itself…" rows={6}
                                            className="pr-ta" />
                                    </Expander>
                                </div>
                            )}

                            {/* ── API tab ── */}
                            {activeLeftTab === 'api' && (
                                <div>
                                    <label style={{ fontSize: '0.62rem', fontWeight: 900, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 10 }}>API Endpoints</label>
                                    <ApiEndpointDesigner endpoints={endpoints} onChange={setEndpoints} />
                                </div>
                            )}

                            {/* ── Capacity tab ── */}
                            {activeLeftTab === 'capacity' && (
                                <div>
                                    <label style={{ fontSize: '0.62rem', fontWeight: 900, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 4 }}>Capacity Estimation</label>
                                    <CapacityEstimator value={capacity} onChange={setCapacity} />
                                </div>
                            )}
                        </div>
        </div>
    )

    // ── CENTER — React Flow Canvas ──────────────────────────────────────
    const centerPanel = (
        <div ref={canvasRef} style={{
            position: 'relative', overflow: 'hidden', background: 'var(--surface)',
            ...(isMobile ? { flex: 1, minHeight: 0 } : null),
        }}>
                        {/* Node palette */}
                        {isMobile ? (
                            <div style={{ position: 'absolute', top: 8, left: 8, right: 8, zIndex: 10, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                                <Button icon={paletteOpen ? X : Plus} aria-expanded={paletteOpen} onClick={() => setPaletteOpen(o => !o)}
                                    style={{ color: ACCENT, background: 'var(--nav-bg)', backdropFilter: 'blur(8px)' }}>
                                    {paletteOpen ? 'Close' : 'Add node'}
                                </Button>
                                {paletteOpen && (
                                    <div style={{
                                        display: 'flex', gap: 4, padding: '6px 8px', maxWidth: '100%', overflowX: 'auto',
                                        background: 'var(--nav-bg)', border: '1px solid var(--subtle)', borderRadius: 8,
                                        backdropFilter: 'blur(8px)', WebkitOverflowScrolling: 'touch',
                                    }}>
                                        {NODE_TYPES_CONFIG.map(paletteChip)}
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div style={{
                                position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 10,
                                display: 'flex', gap: 4, padding: '6px 10px', background: 'var(--nav-bg)',
                                border: '1px solid var(--subtle)', borderRadius: 8, backdropFilter: 'blur(8px)',
                                flexWrap: 'wrap', maxWidth: 'calc(100% - 20px)', justifyContent: 'center',
                            }}>
                                {NODE_TYPES_CONFIG.map(paletteChip)}
                            </div>
                        )}

                        <ReactFlow
                            nodes={nodes} edges={edges}
                            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
                            onConnect={onConnect} onInit={setRfInstance}
                            onDrop={onDrop} onDragOver={onDragOver}
                            onEdgeClick={onEdgeClick} onPaneClick={onPaneClick}
                            nodeTypes={nodeTypes} edgeTypes={edgeTypes}
                            fitView
                            style={{ background: 'var(--surface)' }}
                            connectionLineStyle={{ stroke: '#a78bfa', strokeWidth: 2 }}
                            deleteKeyCode={null}  /* We handle Delete ourselves to also clean edges */
                        >
                            <Background color="#27272a" gap={20} size={1} />
                            <Controls style={{ background: 'var(--panel)', border: '1px solid var(--subtle)' }} />
                            {!isMobile && <MiniMap style={{ background: 'var(--surface-2)', border: '1px solid var(--subtle)' }} nodeColor={n => n.data?.color || 'var(--faint)'} />}
                        </ReactFlow>

                        {/* Edge selection toolbar */}
                        <EdgeToolbar edge={selectedEdge} onUpdate={updateEdge} onDelete={deleteEdge} />

                        {nodes.length === 0 && !(user && !hydrated) && (
                            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', gap: 8 }}>
                                <EmptyArt kind="diagram" tone="plan" size={48} />
                                <p style={{ color: 'var(--muted)', fontSize: '0.82rem', margin: 0 }}>{isMobile ? 'Tap Add node to start' : 'Drag nodes from the palette'}</p>
                                <p style={{ color: 'var(--faint)', fontSize: '0.72rem', margin: 0 }}>Drag from a right handle to a left handle to connect</p>
                            </div>
                        )}

                        {/* Restoring hint — a signed-in user whose saved state hasn't hydrated yet */}
                        {user && !hydrated && (
                            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', gap: 8 }}>
                                <div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid var(--subtle)', borderTopColor: 'var(--sys-plan)', animation: 'spin 0.7s linear infinite' }} />
                                <span style={{ fontSize: 12, color: 'var(--faint)' }}>Restoring workspace…</span>
                            </div>
                        )}
        </div>
    )

    // ── RIGHT PANEL — Judge ─────────────────────────────────────────────
    const rightPanel = (
        <div style={{
            borderLeft: isMobile ? 'none' : '1px solid var(--subtle)', display: 'flex', flexDirection: 'column',
            overflow: 'hidden', background: 'var(--surface-2)', ...(isMobile ? { flex: 1, minHeight: 0 } : null),
        }}>
                        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--subtle)', flexShrink: 0 }}>
                            <p className="pr-ws-hint">Get an AI score for your diagram.</p>
                            <button type="button" className="sys-tone-btn is-block pr-tone" disabled={judging} aria-busy={judging || undefined}
                                onClick={() => { trackUi(TRACK.CTA_CLICK, { id: 'hld_judge', section: 'prepare' }); handleJudge() }}>
                                {judging ? <span className="sys-spin" aria-hidden="true" /> : <Scale size={16} aria-hidden="true" />}
                                <span>{judging ? 'Checking…' : 'Score my design'}</span>
                            </button>
                            {usageLimitNote && <div style={{ marginTop: 10 }}>{usageLimitNote}</div>}
                        </div>

                        <div style={{ flex: 1, overflowY: 'auto', padding: '14px' }}>
                            {judgeResult?.error && (
                                <ErrorState compact title="Judge failed" err={judgeResult.error} onRetry={handleJudge} />
                            )}
                            {judgeResult && !judgeResult.error && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                                        <ScoreRing score={judgeResult.score ?? 0} />
                                        <div>
                                            <p style={{ fontSize: '0.6rem', fontWeight: 900, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 4px' }}>Overall Score</p>
                                            <p style={{ fontSize: '0.75rem', color: 'var(--accent)', margin: 0, lineHeight: 1.5 }}>{judgeResult.summary}</p>
                                        </div>
                                    </div>
                                    {judgeResult.sections && (
                                        <div>
                                            <p style={{ fontSize: '0.6rem', fontWeight: 900, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Section Ratings</p>
                                            {Object.entries(judgeResult.sections).map(([k, v]) => (
                                                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                                                    <span style={{ fontSize: '0.7rem', color: 'var(--muted)', flex: 1, textTransform: 'capitalize' }}>{k}</span>
                                                    <div style={{ width: 60, height: 4, background: 'var(--subtle)', borderRadius: 2 }}>
                                                        <div style={{ width: `${v}%`, height: '100%', background: v >= 70 ? 'var(--sys-success)' : v >= 40 ? 'var(--sys-waiting)' : 'var(--sys-danger)', borderRadius: 2 }} />
                                                    </div>
                                                    <span style={{ fontSize: '0.65rem', color: 'var(--accent)', width: 28, textAlign: 'right' }}>{v}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {judgeResult.pros?.length > 0 && (
                                        <div>
                                            <p style={{ fontSize: '0.6rem', fontWeight: 900, color: 'var(--sys-success)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 5 }}><ThumbsUp size={12} aria-hidden="true" />Strengths</p>
                                            <ul style={{ margin: 0, paddingLeft: 16 }}>
                                                {judgeResult.pros.map((p, i) => <li key={i} style={{ fontSize: '0.73rem', color: 'var(--accent)', marginBottom: 4, lineHeight: 1.4 }}>{p}</li>)}
                                            </ul>
                                        </div>
                                    )}
                                    {judgeResult.cons?.length > 0 && (
                                        <div>
                                            <p style={{ fontSize: '0.6rem', fontWeight: 900, color: 'var(--sys-danger)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 5 }}><Wrench size={12} aria-hidden="true" />Improvements</p>
                                            <ul style={{ margin: 0, paddingLeft: 16 }}>
                                                {judgeResult.cons.map((c, i) => <li key={i} style={{ fontSize: '0.73rem', color: 'var(--accent)', marginBottom: 4, lineHeight: 1.4 }}>{c}</li>)}
                                            </ul>
                                        </div>
                                    )}
                                </div>
                            )}
                            {!judgeResult && !judging && (
                                <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--muted)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                                    <EmptyArt kind="stats" tone="plan" size={44} />
                                    <p style={{ fontSize: '0.75rem', margin: 0 }}>Build your design, then judge it</p>
                                </div>
                            )}
                        </div>
        </div>
    )

    return (
        <>
            <Navbar />
            <div className="pr-ws">
                {/* Compact header: back · title · difficulty · save state; small pane tabs on phones */}
                <div className="pr-ws-top">
                    <PageHeader
                        section="prepare"
                        className="pr-ws-ph"
                        back={{ to: '/hld', label: TERMS.hld.one }}
                        title={problem ? (problem.question || problem.title) : 'System design question'}
                        subtitle={null}
                        aside={problem?.difficulty ? <DifficultyBadge difficulty={problem.difficulty} /> : null}
                        action={!tierLocked && saveState !== 'idle' ? (
                        saveState === 'error' ? (
                            <button type="button" onClick={retrySave} role="alert" style={{
                                fontSize: '0.65rem', fontWeight: 700, padding: '2px 8px', borderRadius: 4, flexShrink: 0, cursor: 'pointer',
                                color: 'var(--red)', background: 'var(--red-bg)', border: '1px solid color-mix(in srgb, var(--red) 35%, transparent)',
                            }}>Save failed – retry</button>
                        ) : (
                            <span role="status" style={{
                                fontSize: '0.65rem', fontWeight: 700, padding: '2px 8px', borderRadius: 4, flexShrink: 0,
                                color: saveState === 'saved' ? 'var(--green)' : 'var(--muted)', border: '1px solid var(--subtle)',
                            }}>{saveState === 'saving' ? 'Saving…' : 'Saved'}</span>
                        )
                    ) : null}
                    />

                    {/* Mobile pane switcher */}
                    {isMobile && !tierLocked && (
                        <SmallTabs idPrefix="hld" label="Workspace panes" section="prepare" value={mobilePane} onChange={setMobilePane} block
                            items={[{ value: 'brief', label: 'Brief' }, { value: 'canvas', label: 'Draw' }, { value: 'judge', label: 'Score' }]} />
                    )}
                </div>

                {/* Body */}
                {tierLocked ? (
                    <div style={{ flex: 1, overflowY: 'auto' }}>
                        <LockedPanel
                            feature="hld_practice"
                            used={error?.used}
                            limit={error?.limit}
                            resetsAt={error?.resetsAt}
                            title="System design practice needs a Pro plan"
                            subtitle="Free plans can browse. Upgrade to draw and get an AI score."
                        />
                    </div>
                ) : !isMobile ? (
                    <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '300px 1fr 280px', overflow: 'hidden' }}>
                        {leftPanel}
                        {centerPanel}
                        {rightPanel}
                    </div>
                ) : (
                    <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
                        <div role="tabpanel" id="hld-panel-brief" aria-labelledby="hld-tab-brief" style={{ position: 'absolute', inset: 0, display: mobilePane === 'brief' ? 'flex' : 'none', flexDirection: 'column' }}>{leftPanel}</div>
                        <div role="tabpanel" id="hld-panel-canvas" aria-labelledby="hld-tab-canvas" style={{ position: 'absolute', inset: 0, display: mobilePane === 'canvas' ? 'flex' : 'none', flexDirection: 'column' }}>{centerPanel}</div>
                        <div role="tabpanel" id="hld-panel-judge" aria-labelledby="hld-tab-judge" style={{ position: 'absolute', inset: 0, display: mobilePane === 'judge' ? 'flex' : 'none', flexDirection: 'column' }}>{rightPanel}</div>
                    </div>
                )}
            </div>
        </>
    )
}

export default function HLDWorkspacePage() {
    return (
        <ReactFlowProvider>
            <HLDWorkspaceInner />
        </ReactFlowProvider>
    )
}

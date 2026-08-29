import { useEffect, useId, useRef, useState } from 'react'

// Load + configure mermaid exactly once for the whole module.
// securityLevel 'strict' sanitises rendered SVG; theme matches the dark UI.
const mermaidReady = import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
    return mermaid
})

export default function MermaidBlock({ code }) {
    const ref = useRef(null)
    // Stable, unique, selector-safe id per component instance.
    const renderId = `mermaid-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`
    const [error, setError] = useState(null)

    useEffect(() => {
        // Guard against StrictMode's double-invoke: only the latest effect
        // run is allowed to write into the container.
        let cancelled = false
        const node = ref.current
        setError(null)

        mermaidReady
            .then((mermaid) => mermaid.render(renderId, code))
            .then(({ svg }) => {
                if (cancelled || !node) return
                node.innerHTML = svg
            })
            .catch((e) => {
                if (!cancelled) setError(e instanceof Error ? e.message : String(e))
            })

        return () => {
            cancelled = true
            if (node) node.innerHTML = ''
        }
    }, [code, renderId])

    if (error) return (
        <pre style={{ color: '#f87171', fontSize: '0.75rem', padding: 8, background: '#1a0a0a', borderRadius: 4, overflow: 'auto' }}>
            [Mermaid error] {error}
        </pre>
    )
    return <div ref={ref} style={{ textAlign: 'center', marginBottom: 12, maxWidth: '100%', overflowX: 'auto' }} />
}

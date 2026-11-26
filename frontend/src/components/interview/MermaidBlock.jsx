import { useEffect, useId, useRef, useState } from 'react'

// Load + configure mermaid lazily, exactly once, on the first render of a
// diagram (not when this module is imported), so pages that merely include
// this component never download the ~600 kB mermaid chunk unless a diagram
// is actually shown. securityLevel 'strict' sanitises rendered SVG.
let mermaidReady = null
function loadMermaid() {
    if (!mermaidReady) {
        mermaidReady = import('mermaid')
            .then(({ default: mermaid }) => {
                mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
                return mermaid
            })
            .catch((e) => {
                mermaidReady = null // let a later render retry (e.g. chunk load after a deploy)
                throw e
            })
    }
    return mermaidReady
}

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

        loadMermaid()
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
        <pre style={{ color: 'var(--red)', fontSize: '0.75rem', padding: 8, background: 'var(--red-bg)', borderRadius: 4, overflow: 'auto' }}>
            [Mermaid error] {error}
        </pre>
    )
    return <div ref={ref} style={{ textAlign: 'center', marginBottom: 12, maxWidth: '100%', overflowX: 'auto' }} />
}

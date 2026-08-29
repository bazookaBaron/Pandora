import { useState, useEffect } from 'react'

// Subscribe to a CSS media query and re-render on match changes.
// SSR-safe-ish: defaults to false when window / matchMedia is unavailable.
export function useMediaQuery(query) {
    const getMatch = () => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
        return window.matchMedia(query).matches
    }

    const [matches, setMatches] = useState(getMatch)

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
        const mql = window.matchMedia(query)
        const onChange = (event) => setMatches(event.matches)
        // Sync once in case the query changed between render and effect
        setMatches(mql.matches)
        mql.addEventListener('change', onChange)
        return () => mql.removeEventListener('change', onChange)
    }, [query])

    return matches
}

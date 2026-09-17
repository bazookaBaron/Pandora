// window.__INITIAL_DATA__ — embedded by the server (lib/seoHead.js's
// initialDataScript, wired in from server.js's catch-all route) only for a
// handful of SEO-critical routes (/dsa, /lld, /hld, /jobs/company/:slug),
// always the anonymous/free-tier view. Read once per key and delete it, so
// a client-side navigation away from the page and back later doesn't
// re-seed react-query with the same stale snapshot — every read after the
// first just falls through to `undefined`, and the query's normal
// queryFn/fetch-on-mount behavior takes over exactly as it did before this
// existed.
export function consumeInitialData(key) {
    const store = typeof window !== 'undefined' ? window.__INITIAL_DATA__ : null
    if (!store || !(key in store)) return undefined
    const value = store[key]
    delete store[key]
    return value
}

/**
 * Tiny in-process TTL + LRU cache with single-flight de-duplication.
 *
 * Used to memoize expensive GET payload builds (catalog + jobs responses that
 * would otherwise re-run full DB fetches + JS transforms on every request).
 * No external deps. Values live only in this process - fine for read-mostly,
 * short-TTL data; not a source of truth.
 *
 *  - True LRU: a hit moves the entry to the most-recent end; eviction removes
 *    the least-recently USED entry.
 *  - Per-namespace caps: the namespace is the key prefix up to the first ":"
 *    ("jobs:abc" -> "jobs"). One namespace (e.g. high-cardinality search keys)
 *    can never evict every other namespace; it only evicts within itself.
 *  - Generation counter: invalidate(prefix) bumps the generation of affected
 *    namespaces, so a producer that was already in flight when invalidate()
 *    ran does NOT store its (stale) result.
 */

const MAX_ENTRIES = 600; // global ceiling
const NAMESPACE_MAX = 150; // default per-namespace cap
const NS_CAPS = { "jobs-company": 300, jobs: 150, dsa: 100, lld: 100, hld: 50, ssr: 100 };

/** @type {Map<string, { value: any, exp: number, ns: string }>} */
const store = new Map(); // insertion order == recency order (oldest first)
/** @type {Map<string, number>} live entries per namespace */
const nsCount = new Map();
/** @type {Map<string, Promise<any>>} */
const inflight = new Map();
/** @type {Map<string, number>} per-namespace generation */
const generations = new Map();
let globalGeneration = 0;

function nsOf(key) {
  const i = key.indexOf(":");
  return i < 0 ? key : key.slice(0, i);
}
function genOf(ns) {
  return (generations.get(ns) || 0) + globalGeneration;
}
function capFor(ns) {
  return NS_CAPS[ns] || NAMESPACE_MAX;
}

function removeEntry(key) {
  const e = store.get(key);
  if (!e) return;
  store.delete(key);
  nsCount.set(e.ns, Math.max(0, (nsCount.get(e.ns) || 1) - 1));
}

function evictOldestInNamespace(ns) {
  for (const [k, e] of store) {
    if (e.ns === ns) {
      removeEntry(k);
      return;
    }
  }
}

function setEntry(key, value, ttlMs) {
  const ns = nsOf(key);
  if (store.has(key)) removeEntry(key);
  while ((nsCount.get(ns) || 0) >= capFor(ns)) evictOldestInNamespace(ns);
  while (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    removeEntry(oldest);
  }
  store.set(key, { value, exp: Date.now() + ttlMs, ns });
  nsCount.set(ns, (nsCount.get(ns) || 0) + 1);
}

/**
 * True if `key` currently has a fresh (non-expired) cached value. Cheap and
 * does not touch recency - handy for an `X-Cache: HIT/MISS` debug header.
 * @param {string} key
 */
export function hasFresh(key) {
  const hit = store.get(key);
  return !!hit && hit.exp > Date.now();
}

/**
 * Return the cached value for `key` if still fresh (marking it most-recently
 * used); otherwise run `producer()` (concurrent callers share one run), store
 * the result for `ttlMs` unless invalidate() ran meanwhile, and return it.
 * A rejected producer is not cached.
 *
 * @template T
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => (T | Promise<T>)} producer
 * @returns {Promise<T>}
 */
export async function cached(key, ttlMs, producer) {
  const hit = store.get(key);
  if (hit) {
    if (hit.exp > Date.now()) {
      // LRU touch: move to the most-recent end.
      store.delete(key);
      store.set(key, hit);
      return hit.value;
    }
    removeEntry(key);
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const ns = nsOf(key);
  const startGen = genOf(ns);
  const p = (async () => producer())();
  inflight.set(key, p);
  try {
    const value = await p;
    // Only store if no invalidate() touched this namespace while we computed.
    if (genOf(ns) === startGen) setEntry(key, value, ttlMs);
    return value;
  } finally {
    if (inflight.get(key) === p) inflight.delete(key);
  }
}

/**
 * Delete every cached entry whose key starts with `prefix` and make any
 * in-flight producer for a matching namespace discard its result. An empty
 * prefix clears everything.
 * @param {string} prefix
 */
export function invalidate(prefix = "") {
  if (!prefix) {
    globalGeneration++;
    for (const k of [...store.keys()]) removeEntry(k);
    inflight.clear();
    return;
  }
  const affected = new Set();
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) {
      affected.add(nsOf(key));
      removeEntry(key);
    }
  }
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) affected.add(nsOf(key));
  }
  // A prefix shorter than a namespace (e.g. "jo") can match several namespaces.
  affected.add(nsOf(prefix));
  for (const ns of affected) generations.set(ns, (generations.get(ns) || 0) + 1);
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(prefix)) inflight.delete(key);
  }
}

/** Test/introspection helper. */
export function _stats() {
  return { size: store.size, namespaces: Object.fromEntries(nsCount) };
}

/**
 * Tiny in-process TTL cache with single-flight de-duplication.
 *
 * Used to memoize expensive GET payload builds (catalog + jobs responses that
 * would otherwise re-run full DB fetches + JS transforms on every request).
 * No external deps. Values live only in this process — fine for read-mostly,
 * short-TTL catalog data; not a source of truth.
 */

const MAX_ENTRIES = 400;

/** Resolved values, keyed by cache key. Map preserves insertion order. */
/** @type {Map<string, { value: any, exp: number }>} */
const store = new Map();

/** In-flight producer promises, so concurrent callers share one run. */
/** @type {Map<string, Promise<any>>} */
const inflight = new Map();

function setEntry(key, value, ttlMs) {
  // Size cap: evict the oldest inserted key when full.
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value, exp: Date.now() + ttlMs });
}

/**
 * True if `key` currently has a fresh (non-expired) cached value. Cheap,
 * side-effect-free — handy for an `X-Cache: HIT/MISS` debug header.
 * @param {string} key
 * @returns {boolean}
 */
export function hasFresh(key) {
  const hit = store.get(key);
  return !!hit && hit.exp > Date.now();
}

/**
 * Return the cached value for `key` if still fresh; otherwise run `producer()`
 * (de-duplicated: concurrent callers for the same key await the same promise),
 * store the resolved value for `ttlMs`, and return it.
 *
 * A rejected producer is NOT cached — the error propagates and the in-flight
 * entry is cleared so the next call retries.
 *
 * @template T
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => (T | Promise<T>)} producer
 * @returns {Promise<T>}
 */
export async function cached(key, ttlMs, producer) {
  const hit = store.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;

  const pending = inflight.get(key);
  if (pending) return pending;

  // Wrap so a synchronous throw in `producer` becomes a rejected promise.
  const p = (async () => producer())();
  inflight.set(key, p);
  try {
    const value = await p;
    setEntry(key, value, ttlMs);
    return value;
  } finally {
    // Always clear the in-flight slot — on success the value is now in `store`,
    // on failure nothing is cached and the next caller retries.
    inflight.delete(key);
  }
}

/**
 * Delete every cached entry whose key starts with `prefix`. In-flight producers
 * are left to settle (their results simply won't be read back).
 * @param {string} prefix
 */
export function invalidate(prefix) {
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

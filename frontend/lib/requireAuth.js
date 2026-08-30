/**
 * Express auth middleware backed by Supabase (service-role verification).
 *
 *   requireAuth   — 401 unless a valid `Authorization: Bearer <jwt>` is present.
 *   optionalAuth  — same verification, but never blocks: sets req.user = null
 *                   when the token is missing or invalid.
 *
 * A short-lived in-process cache (token -> { user, exp }) avoids a Supabase
 * round-trip on every request. TTL ~60s, size-capped to bound memory.
 */
import { supabaseAdmin } from "./supabaseAdmin.js";

const TTL_MS = 60 * 1000;
const MAX_ENTRIES = 500;

/** @type {Map<string, { user: { id: string, email: string|null }, exp: number }>} */
const cache = new Map();

function cacheGet(token) {
  const hit = cache.get(token);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    cache.delete(token);
    return null;
  }
  return hit.user;
}

function cacheSet(token, user) {
  if (cache.size >= MAX_ENTRIES) {
    // drop oldest inserted entry
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(token, { user, exp: Date.now() + TTL_MS });
}

function readBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1].trim() : null;
}

/**
 * Resolve a bearer token to a user object, or null if invalid/expired.
 * @returns {Promise<{ id: string, email: string|null } | null>}
 */
export async function resolveUser(token) {
  if (!token) return null;

  const cached = cacheGet(token);
  if (cached) return cached;

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return null;
    const user = { id: data.user.id, email: data.user.email ?? null };
    cacheSet(token, user);
    return user;
  } catch {
    // supabaseAdmin proxy throws when the service-role key is absent — treat as
    // "cannot verify" rather than crashing the request pipeline.
    return null;
  }
}

export async function requireAuth(req, res, next) {
  const token = readBearer(req);
  if (!token) return res.status(401).json({ error: "auth required" });

  const user = await resolveUser(token);
  if (!user) return res.status(401).json({ error: "auth required" });

  req.user = user;
  req.authToken = token;
  next();
}

export async function optionalAuth(req, _res, next) {
  const token = readBearer(req);
  req.user = token ? await resolveUser(token) : null;
  req.authToken = req.user ? token : null;
  next();
}

export const _authCache = cache; // exported for tests / introspection

/**
 * Pure helpers for the jobs feed API + digest. No I/O and no imports, so they
 * are trivially unit-testable (see test/jobs-feed.test.mjs).
 */

export const JOBS_PAGE_SIZE = 20;
export const SENIORITY_ORDER = ["intern", "junior", "mid", "senior", "staff", "principal", "unknown"];
export const COMPANY_TYPES = ["product", "startup", "service"];
export const COUNTRIES = ["US", "IN"];
/** Max ids per PostgREST `.in()` request (keeps the URL well under proxy limits). */
export const IN_CHUNK_SIZE = 100;

/**
 * Return a normalized absolute http(s) URL string, or null for anything else
 * (javascript:, data:, relative, garbage, non-strings).
 */
export function safeHttpUrl(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s || s.length > 2048) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  return u.href;
}

/** alt_urls jsonb -> [{url, source}] with only valid http(s) urls (deduped, max 10). */
export function normalizeAltUrls(raw, excludeUrl = null) {
  let list = raw;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set(excludeUrl ? [excludeUrl] : []);
  const out = [];
  for (const entry of list) {
    const rawUrl = entry && typeof entry === "object" ? entry.url : entry;
    const url = safeHttpUrl(rawUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const source = entry && typeof entry === "object" && typeof entry.source === "string" ? entry.source.slice(0, 40) : "";
    out.push({ url, source });
    if (out.length >= 10) break;
  }
  return out;
}

const iso = (v) => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * crawler.job_feed / feed_page row (or a job_posting-shaped row) -> the object
 * JobsPage.jsx renders. Returns null when no valid http(s) url remains.
 */
export function mapFeedRow(row) {
  if (!row) return null;
  const applyUrl = safeHttpUrl(row.apply_url);
  const url = safeHttpUrl(row.url) || applyUrl;
  if (!url) return null;
  let locationType = String(row.location_type || "").toLowerCase();
  if (locationType === "telecommute") locationType = "remote";
  if (locationType === "on_site") locationType = "onsite";
  const repostedAt = iso(row.reposted_at);
  const postedAt = iso(row.eff_at) || iso(row.posted_at) || iso(row.first_seen_at);
  return {
    id: row.id,
    title: String(row.title || ""),
    company: String(row.company_name || row.company_slug || ""),
    companySlug: row.company_slug || "",
    companyType: row.company_type || "unknown",
    location: row.location || "",
    locationType,
    country: row.country || "",
    seniority: row.seniority || "",
    employmentType: row.employment_type || "",
    url,
    applyUrl,
    altUrls: normalizeAltUrls(row.alt_urls, url),
    source: row.source || "",
    firstSeen: iso(row.first_seen_at),
    lastSeen: iso(row.last_seen_at),
    postedAt,
    repostedAt,
    repostCount: Number(row.repost_count) || 0,
    isReposted: !!repostedAt,
    status: row.status || "open",
  };
}

/** Split an array into chunks of at most `size` (default IN_CHUNK_SIZE). */
export function chunk(list, size = IN_CHUNK_SIZE) {
  const n = Math.max(1, Math.floor(size) || 1);
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Run `fetchChunk(ids)` (returning { data, error }) over chunked id lists and
 * concatenate the rows. Throws the first error.
 */
export async function inChunks(ids, fetchChunk, size = IN_CHUNK_SIZE) {
  const rows = [];
  for (const part of chunk(ids, size)) {
    const { data, error } = await fetchChunk(part);
    if (error) throw error;
    if (data) rows.push(...data);
  }
  return rows;
}

const csv = (v, max, n) =>
  String(Array.isArray(v) ? v.join(",") : v || "")
    .split(",")
    .map((s) => s.trim().slice(0, max))
    .filter(Boolean)
    .slice(0, n);

/** Validate/normalize GET /api/jobs query params into a plain object. */
export function parseJobsQuery(query = {}) {
  const one = (k, max) => String(Array.isArray(query[k]) ? query[k][0] : query[k] || "").trim().slice(0, max);
  const days = Math.max(0, Math.min(31, parseInt(one("posted_within", 4), 10) || 0));
  const sortRaw = one("sort", 20);
  const countries = csv(query.country, 8, 6)
    .map((c) => c.toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c) || c === "OTHER");
  return {
    q: one("q", 120) || one("search", 120),
    company: one("company", 80),
    locations: csv(query.location, 80, 12),
    locationType: one("location_type", 20).toLowerCase(),
    seniority: csv(query.seniority, 20, 7).map((s) => s.toLowerCase()).filter((s) => SENIORITY_ORDER.includes(s)),
    source: csv(query.source, 40, 8).map((s) => s.toLowerCase()),
    country: [...new Set(countries)],
    companyType: csv(query.company_type, 20, 3).map((s) => s.toLowerCase()).filter((s) => COMPANY_TYPES.includes(s)),
    hours: days > 0 ? days * 24 : null,
    sort: ["oldest", "company"].includes(sortRaw) ? sortRaw : "newest",
    page: Math.max(1, Math.min(10_000, parseInt(one("page", 6), 10) || 1)),
  };
}

/** True when no filter narrows the feed (default view). */
export function isUnfilteredQuery(p) {
  return !(
    p.q || p.company || p.locations.length || p.locationType || p.seniority.length ||
    p.source.length || p.country.length || p.companyType.length || p.hours
  );
}

/** Stable cache key for a parsed query (page included). */
export function jobsCacheKey(plan, p) {
  return `jobs:${plan}:${JSON.stringify([p.q, p.company, p.locations, p.locationType, p.seniority, p.source, p.country, p.companyType, p.hours, p.sort, p.page])}`;
}

/** Arguments for rpc('feed_page', ...). NULL = no filter. */
export function feedPageArgs(p, offset, limit) {
  const nz = (v) => (v ? v : null);
  const arr = (a) => (a.length ? a : null);
  return {
    p_q: nz(p.q),
    p_company: nz(p.company),
    // Multiple locations are '|'-separated; feed_page ORs them.
    p_location: p.locations.length ? p.locations.join("|") : null,
    p_location_type: nz(p.locationType),
    p_seniority: arr(p.seniority),
    p_source: arr(p.source),
    p_country: arr(p.country),
    p_company_type: arr(p.companyType),
    p_hours: p.hours,
    p_offset: offset,
    p_limit: limit,
  };
}

/** Escape a user string for use inside ILIKE patterns (and strip PostgREST list syntax). */
export function likeSafe(s) {
  return String(s || "").replace(/[\%_,()*]/g, " ").trim().replace(/\s+/g, " ");
}

/** Escape text for HTML (email bodies). */
export function escapeHtml(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

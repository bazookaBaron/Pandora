/**
 * Jobs board API (read-only view of the crawler's `crawler.job_feed`).
 *
 *   GET /api/jobs                   paged feed (default = job_feed order, filters = feed_page RPC)
 *   GET /api/jobs/company/:slug     per-company hub payload
 *   GET /api/jobs/facets            autocomplete (company / location / title)
 *   GET /api/jobs/analytics         aggregate metrics (same window as the feed)
 *   GET /api/jobs/analytics/trend   daily-snapshot trend, resampled
 *
 * Mounted from server.js: `app.use(createJobsRouter({ catalogLimiter, fail }))`.
 * The crawler owns the schema (see sql/29_jobs_feed_reader.sql for the read
 * helpers this module calls).
 */
import express from "express";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { optionalAuth } from "../lib/requireAuth.js";
import { getUserPlan } from "../lib/entitlements.js";
import { getLimit, isUnlimited, serializeLimit } from "../config/tiers.js";
import { cached, hasFresh } from "../lib/microCache.js";
import { evaluateJobHubIndexability } from "../lib/seoHead.js";
import {
  JOBS_PAGE_SIZE,
  SENIORITY_ORDER,
  COMPANY_TYPES,
  COUNTRIES,
  mapFeedRow,
  parseJobsQuery,
  isUnfilteredQuery,
  jobsCacheKey,
  feedPageArgs,
  likeSafe,
} from "../lib/jobsFeedUtil.js";

const JOBS_SCHEMA = process.env.JOBS_SCHEMA || "crawler";
const FEED_TABLE = "job_feed";
const PLAN_GATED_CACHE = "private, no-cache";
const JOBS_RESPONSE_TTL_MS = 45_000;
const FEED_COLUMNS =
  "feed_position, id, company_slug, company_key, company_name, company_type, title, url, apply_url, alt_urls, location, location_type, country, seniority, source, posted_at, reposted_at, repost_count, eff_at, first_seen_at";

export const JOBS_COMPANY_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/;
const JOBS_COMPANY_CURATED_N = Number(process.env.JOBS_COMPANY_CURATED_N) || 50;

export function jobsDb() {
  return JOBS_SCHEMA && JOBS_SCHEMA !== "public" ? supabaseAdmin.schema(JOBS_SCHEMA) : supabaseAdmin;
}

const NOT_READY_RE =
  /relation .* does not exist|column .* does not exist|function .* does not exist|Could not find the (table|function|.*column)|schema cache|schema must be one of|The schema must be|not exposed|PGRST106|PGRST202|PGRST205/i;
const isNotReady = (err) => NOT_READY_RE.test(String((err && err.message) || err));

// ── Curated company slugs (top N by open volume) ─────────────────────
async function loadCuratedSlugs() {
  return cached("jobs-company:curated", 600_000, async () => {
    const { data, error } = await jobsDb().rpc("company_job_counts", { p_limit: JOBS_COMPANY_CURATED_N });
    if (error) throw error;
    return new Set(
      (data || [])
        .filter((r) => r && r.company_slug)
        .sort((a, b) => Number(b.open_count) - Number(a.open_count))
        .slice(0, JOBS_COMPANY_CURATED_N)
        .map((r) => r.company_slug),
    );
  });
}

export async function getCuratedJobsCompanySlugs() {
  try {
    return await loadCuratedSlugs();
  } catch (e) {
    console.warn("[jobs] curated slugs unavailable:", String((e && e.message) || e).slice(0, 200));
    return new Set(); // not cached (cached() drops rejected producers), so the next call retries
  }
}

// Cosmetic fallback only — mirrors lib/seoHead.js's humanizeSlug().
function humanizeSlugFallback(slug) {
  return String(slug || "").split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// Returns null for an unknown company slug, else the hub payload. Shared by
// the JSON API, the sitemap and the SSR shell (server.js imports this).
export async function getJobsCompanyPayload(slug) {
  return cached(`jobs-company:${slug}`, 300_000, async () => {
    const { data: company } = await jobsDb().from("company").select("slug, name").eq("slug", slug).maybeSingle();
    if (!company) return null;

    const { data: rows, error } = await jobsDb()
      .from(FEED_TABLE)
      .select(FEED_COLUMNS)
      .eq("company_slug", slug)
      .order("eff_at", { ascending: false })
      .limit(300);
    if (error) throw error;

    const postings = (rows || []).map(mapFeedRow).filter(Boolean);
    const recordCount = postings.length;
    const completeRecordCount = postings.filter((r) => r.title && r.location).length;
    const uniqueFactCount = new Set(postings.map((r) => `${r.title}|${r.location}`)).size;
    const words = (s) => String(s || "").split(/\s+/).filter(Boolean).length;
    const substantiveWordCount = postings.reduce((sum, r) => sum + words(r.title) + words(r.location), 0) + 60;
    const newestSeenAt = postings.reduce((max, r) => Math.max(max, Date.parse(r.firstSeen) || Date.parse(r.postedAt) || 0), 0);
    const newestAgeDays = newestSeenAt ? (Date.now() - newestSeenAt) / 86_400_000 : Number.POSITIVE_INFINITY;

    const curatedSlugs = await getCuratedJobsCompanySlugs();
    const decision = evaluateJobHubIndexability({
      recordCount,
      completeRecordCount,
      uniqueFactCount,
      substantiveWordCount,
      newestAgeDays,
      curated: curatedSlugs.has(slug),
    });

    return {
      company: { slug: company.slug, name: company.name || humanizeSlugFallback(slug) },
      postings,
      eligible: decision.eligible,
      reasons: decision.reasons,
    };
  });
}

// ── Facets ─────────────────────────────────────────────────────────
const FACET_FIELD_COLUMN = { company: "company_name", location: "location", title: "title" };

// Lightweight fuzzy matcher: exact > prefix > substring > in-order subsequence.
export function fuzzyScore(query, target) {
  const q = String(query || "").toLowerCase().trim();
  const t = String(target || "").toLowerCase().trim();
  if (!q) return 1;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900 - t.length;
  const idx = t.indexOf(q);
  if (idx >= 0) return 700 - idx - t.length * 0.1;
  let ti = 0;
  let hits = 0;
  let streak = 0;
  let best = 0;
  for (const c of q) {
    let found = -1;
    for (let k = ti; k < t.length; k++) {
      if (t[k] === c) { found = k; break; }
    }
    if (found === -1) return -1;
    streak = found === ti ? streak + 1 : 1;
    if (streak > best) best = streak;
    hits += 1;
    ti = found + 1;
  }
  return 200 + best * 10 - (t.length - hits);
}

export function rankFacet(candidates, q, limit) {
  const uniq = [...new Set(candidates.filter(Boolean))];
  if (!q) return uniq.slice(0, limit);
  return uniq
    .map((c) => [fuzzyScore(q, c), c])
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]))
    .slice(0, limit)
    .map(([, c]) => c);
}

async function facetRpc(column, q, limit) {
  const { data, error } = await jobsDb().rpc("job_feed_facet", { p_field: column, p_q: q || "", p_limit: limit });
  if (error) throw error;
  return (data || []).map((r) => String(r.value || "").trim()).filter(Boolean);
}

// Top values (by count) per field, cached 5 min — typed queries are ranked
// against this locally, so a keystroke only hits the DB when nothing matches.
function facetCandidates(field) {
  return cached(`jobs-facet-candidates:${field}`, 300_000, () => facetRpc(FACET_FIELD_COLUMN[field], "", 1000));
}

async function buildFacet(field, q, limit) {
  if (field === "title") {
    if (!q) return { field, options: [] };
    return { field, options: await facetRpc("title", q, limit) };
  }
  const candidates = await facetCandidates(field);
  const local = rankFacet(candidates, q, limit);
  if (q && local.length < limit && q.length >= 2) {
    // Long tail not in the top-1000 list: ask SQL (prefix/trigram), cached per q.
    const remote = await facetRpc(FACET_FIELD_COLUMN[field], q, limit);
    return { field, options: [...new Set([...local, ...remote])].slice(0, limit) };
  }
  return { field, options: local };
}

// ── Analytics ──────────────────────────────────────────────────────
async function buildAnalytics() {
  const rpc = await jobsDb().rpc("jobs_feed_analytics");
  if (!rpc.error && rpc.data) {
    const d = rpc.data;
    return {
      total: d.total ?? 0,
      companiesWithJobs: d.companies_with_jobs ?? 0,
      bySeniority: d.by_seniority ?? [],
      byWorkType: d.by_work_type ?? [],
      bySource: d.by_source ?? [],
      topCompanies: (d.top_companies ?? []).map((c) => ({ company: c.name || c.slug, count: c.count })),
      postedByDay: d.posted_by_day ?? [],
      midSharePct: d.mid_share_pct ?? null,
    };
  }

  // Fallback: head-only COUNT queries on job_feed, run in parallel.
  const countWhere = async (apply) => {
    let q = jobsDb().from(FEED_TABLE).select("id", { count: "exact", head: true });
    if (apply) q = apply(q);
    const { count, error } = await q;
    if (error) throw error;
    return count || 0;
  };
  const workTypes = ["remote", "hybrid", "onsite"];
  const [total, ...rest] = await Promise.all([
    countWhere(),
    ...workTypes.map((t) => countWhere((q) => q.eq("location_type", t))),
    ...SENIORITY_ORDER.map((b) => countWhere((q) => q.eq("seniority", b)).catch(() => null)),
  ]);
  const wtCounts = rest.slice(0, workTypes.length);
  const senCounts = rest.slice(workTypes.length);
  const typed = wtCounts.reduce((a, b) => a + b, 0);
  const byWorkType = workTypes.map((type, i) => ({ type, count: wtCounts[i] }));
  byWorkType.push({ type: "unspecified", count: Math.max(0, total - typed) });
  const senOk = senCounts.every((c) => c !== null);
  const bySeniority = senOk ? SENIORITY_ORDER.map((bucket, i) => ({ bucket, count: senCounts[i] })) : [];
  const midCount = senOk ? senCounts[SENIORITY_ORDER.indexOf("mid")] : 0;
  return {
    total,
    companiesWithJobs: null,
    bySeniority,
    byWorkType,
    bySource: [],
    topCompanies: [],
    postedByDay: [],
    midSharePct: total && senOk ? Math.round((midCount / total) * 1000) / 10 : null,
  };
}

// ── Trend ──────────────────────────────────────────────────────────
const JOBS_SNAPSHOT_TABLE = "jobs_market_snapshot_daily";
const TREND_MAX_ROWS = 1000;

const jobsWeekBucketKey = (dateStr) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
};
const jobsMonthBucketKey = (dateStr) => String(dateStr).slice(0, 7);

function mergeJsonbCounts(target, obj) {
  for (const [k, v] of Object.entries(obj || {})) target[k] = (target[k] || 0) + (Number(v) || 0);
}

function mergeTopCompanies(target, arr) {
  for (const c of Array.isArray(arr) ? arr : []) {
    const name = c && (c.company || c.name);
    if (!name) continue;
    target[name] = (target[name] || 0) + (Number(c.new_postings ?? c.newPostings ?? c.count) || 0);
  }
}

/** Resample ascending-by-date daily rows into week/month buckets. */
export function resampleJobsSnapshots(rowsAsc, granularity) {
  const keyFn = granularity === "monthly" ? jobsMonthBucketKey : jobsWeekBucketKey;
  const buckets = new Map();
  for (const row of rowsAsc) {
    const period = keyFn(row.snapshot_date);
    let b = buckets.get(period);
    if (!b) {
      b = { period, totalOpen: 0, newPostings: 0, closedPostings: 0, bySeniority: {}, byWorkType: {}, byCountry: {}, byCompanyType: {}, topCompaniesAcc: {} };
      buckets.set(period, b);
    }
    b.newPostings += Number(row.new_postings) || 0;
    b.closedPostings += Number(row.closed_postings) || 0;
    b.totalOpen = Number(row.total_open) || 0; // ascending rows → last write = latest day
    mergeJsonbCounts(b.bySeniority, row.by_seniority);
    mergeJsonbCounts(b.byWorkType, row.by_work_type);
    mergeJsonbCounts(b.byCountry, row.by_country);
    mergeJsonbCounts(b.byCompanyType, row.by_company_type);
    mergeTopCompanies(b.topCompaniesAcc, row.top_companies);
  }
  return [...buckets.values()]
    .sort((a, b) => a.period.localeCompare(b.period))
    .map((b) => ({
      period: b.period,
      totalOpen: b.totalOpen,
      newPostings: b.newPostings,
      closedPostings: b.closedPostings,
      bySeniority: b.bySeniority,
      byWorkType: b.byWorkType,
      byCountry: b.byCountry,
      byCompanyType: b.byCompanyType,
      topCompanies: Object.entries(b.topCompaniesAcc)
        .sort((a, c) => c[1] - a[1])
        .slice(0, 10)
        .map(([company, newPostings]) => ({ company, newPostings })),
    }));
}

// ── Feed query ─────────────────────────────────────────────────────
// PostgREST filters over job_feed — used for the unfiltered default view and
// for the non-default sorts (oldest / company), which feed_page doesn't serve.
function applyDirectFilters(q, p) {
  if (p.q) {
    const s = likeSafe(p.q).replace(/ /g, "*");
    if (s) q = q.or(`title.ilike.*${s}*,company_name.ilike.*${s}*`);
  }
  if (p.company) q = q.ilike("company_name", `%${likeSafe(p.company).replace(/[\s-]+/g, "%")}%`);
  if (p.locations.length === 1) q = q.ilike("location", `%${likeSafe(p.locations[0]).replace(/ /g, "%")}%`);
  else if (p.locations.length > 1) {
    q = q.or(p.locations.map((l) => `location.ilike.*${likeSafe(l).replace(/ /g, "*")}*`).join(","));
  }
  if (p.locationType) q = q.eq("location_type", p.locationType);
  if (p.seniority.length) q = q.in("seniority", p.seniority);
  if (p.source.length) q = q.in("source", p.source);
  if (p.country.length) {
    const codes = p.country.filter((c) => c !== "OTHER");
    if (p.country.includes("OTHER")) {
      q = codes.length
        ? q.or(`country.in.(${codes.join(",")}),country.is.null`)
        : q.or("country.is.null,country.not.in.(US,IN)");
    } else q = q.in("country", codes);
  }
  if (p.companyType.length) q = q.in("company_type", p.companyType);
  if (p.hours) q = q.gte("eff_at", new Date(Date.now() - p.hours * 3_600_000).toISOString());
  return q;
}

async function fetchFeedPage(p, offset, limit) {
  const db = jobsDb();
  if (p.sort === "newest" && !isUnfilteredQuery(p)) {
    const { data, error } = await db.rpc("feed_page", feedPageArgs(p, offset, limit));
    if (error) throw error;
    const rows = data || [];
    let count = rows.length ? Number(rows[0].total_count) : null;
    if (count === null) {
      if (offset === 0) count = 0;
      else {
        // Page beyond the end: one cheap probe for the real total.
        const probe = await db.rpc("feed_page", feedPageArgs(p, 0, 1));
        if (probe.error) throw probe.error;
        count = probe.data && probe.data.length ? Number(probe.data[0].total_count) : 0;
      }
    }
    return { rows, count };
  }
  let q = db.from(FEED_TABLE).select(FEED_COLUMNS, { count: "exact" });
  q = applyDirectFilters(q, p);
  if (p.sort === "oldest") q = q.order("eff_at", { ascending: true }).order("id", { ascending: true });
  else if (p.sort === "company") q = q.order("company_name", { ascending: true }).order("eff_at", { ascending: false });
  else q = q.order("feed_position", { ascending: true });
  const { data, error, count } = await q.range(offset, offset + limit - 1);
  if (error) throw error;
  return { rows: data || [], count: count ?? (data || []).length };
}

async function getSources() {
  try {
    return await cached("jobs:sources", 600_000, async () => {
      const { data, error } = await jobsDb().rpc("job_feed_sources");
      if (error) throw error;
      return (data || []).map((r) => r.source).filter(Boolean).slice(0, 40);
    });
  } catch {
    return []; // facets are optional
  }
}

async function buildJobsPayload(p, plan) {
  const jobsLimit = getLimit(plan, "jobs_visible");
  const jobsUnlimited = isUnlimited(jobsLimit);
  const from = (p.page - 1) * JOBS_PAGE_SIZE;
  const to = from + JOBS_PAGE_SIZE - 1;
  // Free tier only ever exposes the first `jobsLimit` postings.
  const cappedTo = jobsUnlimited ? to : Math.min(to, jobsLimit - 1);
  const pastCap = !jobsUnlimited && from > cappedTo;

  // pastCap: fetch a single dummy row purely to keep the count accurate.
  const offset = pastCap ? 0 : from;
  const limit = pastCap ? 1 : cappedTo - from + 1;
  const [{ rows, count }, sources] = await Promise.all([fetchFeedPage(p, offset, limit), getSources()]);

  const items = pastCap ? [] : rows.map(mapFeedRow).filter(Boolean);
  const total = count ?? items.length;
  return {
    items,
    total,
    page: p.page,
    pageCount: jobsUnlimited ? Math.max(1, Math.ceil(total / JOBS_PAGE_SIZE)) : 1,
    locked: jobsUnlimited ? 0 : Math.max(0, total - jobsLimit),
    limit: serializeLimit(jobsLimit),
    facets: {
      sources,
      locationTypes: ["remote", "hybrid", "onsite"],
      seniorities: SENIORITY_ORDER,
      companyTypes: COMPANY_TYPES,
      countries: COUNTRIES,
    },
  };
}

function jobsNotReady(res) {
  return res.json({
    items: [],
    total: 0,
    page: 1,
    pageCount: 1,
    facets: { sources: [], locationTypes: ["remote", "hybrid", "onsite"], seniorities: SENIORITY_ORDER },
    notReady: true,
  });
}

/**
 * @param {{ catalogLimiter: import("express").RequestHandler,
 *           fail: (res:any, err:any, label:string, msg?:string)=>void }} deps
 */
export function createJobsRouter({ catalogLimiter, fail }) {
  const router = express.Router();

  router.get("/api/jobs", catalogLimiter, optionalAuth, async (req, res) => {
    try {
      const plan = req.user ? await getUserPlan(req.user.id) : "free";
      const p = parseJobsQuery(req.query);
      const key = jobsCacheKey(plan, p);
      const wasHit = hasFresh(key);
      const payload = await cached(key, JOBS_RESPONSE_TTL_MS, () => buildJobsPayload(p, plan));
      res.set("Cache-Control", PLAN_GATED_CACHE);
      res.set("X-Cache", wasHit ? "HIT" : "MISS");
      res.json(payload);
    } catch (err) {
      if (isNotReady(err)) return jobsNotReady(res);
      fail(res, err, "jobs", "Failed to load jobs.");
    }
  });

  router.get("/api/jobs/company/:slug", catalogLimiter, optionalAuth, async (req, res) => {
    try {
      const slug = String(req.params.slug || "").trim().toLowerCase();
      if (!JOBS_COMPANY_SLUG_RE.test(slug)) return res.status(404).json({ error: "Unknown company." });
      const key = `jobs-company:${slug}`;
      const wasHit = hasFresh(key);
      const payload = await getJobsCompanyPayload(slug);
      if (!payload) return res.status(404).json({ error: "Unknown company." });
      res.set("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
      res.set("X-Cache", wasHit ? "HIT" : "MISS");
      res.json(payload);
    } catch (err) {
      fail(res, err, "jobs/company", "Failed to load company jobs.");
    }
  });

  router.get("/api/jobs/facets", catalogLimiter, optionalAuth, async (req, res) => {
    const field = String(req.query.field || "").trim().toLowerCase();
    try {
      const q = String(req.query.q || "").trim().slice(0, 60);
      const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 10));
      if (!FACET_FIELD_COLUMN[field]) {
        return res.status(400).json({ error: "field must be 'company', 'location' or 'title'" });
      }
      const key = `jobs-facet:${field}:${limit}:${q.toLowerCase()}`;
      const wasHit = hasFresh(key);
      const payload = await cached(key, 300_000, () => buildFacet(field, q, limit));
      res.set("Cache-Control", "public, max-age=120, s-maxage=300");
      res.set("X-Cache", wasHit ? "HIT" : "MISS");
      return res.json(payload);
    } catch (err) {
      if (isNotReady(err)) return res.json({ field, options: [] });
      fail(res, err, "jobs-facets", "Failed to load suggestions.");
    }
  });

  router.get("/api/jobs/analytics", catalogLimiter, optionalAuth, async (_req, res) => {
    try {
      const wasHit = hasFresh("jobs-analytics");
      const payload = await cached("jobs-analytics", 300_000, buildAnalytics);
      res.set("Cache-Control", "public, max-age=120, s-maxage=300");
      res.set("X-Cache", wasHit ? "HIT" : "MISS");
      res.json(payload);
    } catch (err) {
      if (isNotReady(err) || /PGRST1|PGRST2/.test(String((err && err.message) || err))) {
        return res.json({
          total: 0, companiesWithJobs: 0, bySeniority: [], byWorkType: [], bySource: [],
          topCompanies: [], postedByDay: [], midSharePct: null, notReady: true,
        });
      }
      fail(res, err, "jobs/analytics", "Failed to load job analytics.");
    }
  });

  router.get("/api/jobs/analytics/trend", catalogLimiter, optionalAuth, async (req, res) => {
    const granularity = String(req.query.granularity || "weekly").trim().toLowerCase() === "monthly" ? "monthly" : "weekly";
    try {
      const key = `jobs-trend:${granularity}`;
      const wasHit = hasFresh(key);
      const payload = await cached(key, 300_000, async () => {
        // Newest first with a limit so the most recent window always survives
        // the cap, then flip back to ascending for resampling.
        const { data, error } = await supabaseAdmin
          .from(JOBS_SNAPSHOT_TABLE)
          .select("snapshot_date, total_open, new_postings, closed_postings, by_seniority, by_work_type, by_country, by_company_type, top_companies")
          .order("snapshot_date", { ascending: false })
          .limit(TREND_MAX_ROWS);
        if (error) throw error;
        const rowsAsc = (data || []).slice().reverse();
        return { granularity, points: rowsAsc.length ? resampleJobsSnapshots(rowsAsc, granularity) : [] };
      });
      res.set("Cache-Control", "public, max-age=120, s-maxage=300");
      res.set("X-Cache", wasHit ? "HIT" : "MISS");
      res.json(payload);
    } catch (err) {
      if (/relation .* does not exist|does not exist|schema cache|PGRST1|PGRST2/i.test(String((err && err.message) || err))) {
        return res.json({ granularity, points: [], notReady: true });
      }
      fail(res, err, "jobs/analytics/trend", "Failed to load job trend.");
    }
  });

  return router;
}

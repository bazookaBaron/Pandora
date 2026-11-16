/**
 * Unit tests for the jobs feed helpers + digest utilities. No network/DB.
 * Run: node --test test/jobs-feed.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  safeHttpUrl, normalizeAltUrls, mapFeedRow, chunk, inChunks, parseJobsQuery,
  isUnfilteredQuery, feedPageArgs, jobsCacheKey, escapeHtml, likeSafe,
} from "../lib/jobsFeedUtil.js";
import { createThrottle, sendWithRetry, mapWithConcurrency, sanitizePostings, fetchAllPages } from "../lib/jobsDigest.js";
import { rankFacet, resampleJobsSnapshots } from "../routes/jobs.js";

test("safeHttpUrl accepts only http(s)", () => {
  assert.equal(safeHttpUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(safeHttpUrl("  http://x.io  "), "http://x.io/");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://x.com", "//x.com", "/rel", "", null, undefined, 5, "not a url", "JaVaScRiPt:alert(1)"]) {
    assert.equal(safeHttpUrl(bad), null, String(bad));
  }
});

test("normalizeAltUrls drops invalid, dupes and the primary url", () => {
  const out = normalizeAltUrls([
    { url: "https://a.com/1", source: "greenhouse" },
    "https://b.com/2",
    { url: "javascript:x" },
    { url: "https://a.com/1" },
    { url: "https://main.com/" },
    null,
  ], "https://main.com/");
  assert.deepEqual(out, [{ url: "https://a.com/1", source: "greenhouse" }, { url: "https://b.com/2", source: "" }]);
  assert.deepEqual(normalizeAltUrls("not json"), []);
  assert.deepEqual(normalizeAltUrls('[{"url":"https://c.com"}]'), [{ url: "https://c.com/", source: "" }]);
});

test("mapFeedRow maps new fields and validates urls", () => {
  const j = mapFeedRow({
    id: 7, company_slug: "acme", company_name: "Acme Inc", title: "Engineer", url: "https://l.com/1",
    apply_url: "javascript:evil", alt_urls: [{ url: "https://ats.com/1", source: "lever" }], source: "linkedin",
    posted_at: "2026-11-15T10:00:00Z", reposted_at: "2026-11-16T01:00:00Z", repost_count: 2,
    eff_at: "2026-11-16T01:00:00Z", first_seen_at: "2026-11-15T12:00:00Z", location_type: "telecommute", company_type: "product",
  });
  assert.equal(j.company, "Acme Inc");
  assert.equal(j.applyUrl, null);
  assert.equal(j.postedAt, "2026-11-16T01:00:00.000Z");
  assert.equal(j.firstSeen, "2026-11-15T12:00:00.000Z");
  assert.equal(j.isReposted, true);
  assert.equal(j.repostCount, 2);
  assert.equal(j.locationType, "remote");
  assert.deepEqual(j.altUrls, [{ url: "https://ats.com/1", source: "lever" }]);
  assert.equal(j.source, "linkedin");
  const n = mapFeedRow({ id: 1, company_slug: "x", title: "t", url: "https://x.com", posted_at: "2026-11-16T00:00:00Z" });
  assert.equal(n.isReposted, false);
  assert.equal(n.repostedAt, null);
  assert.equal(n.postedAt, "2026-11-16T00:00:00.000Z");
  assert.equal(mapFeedRow({ id: 2, url: "javascript:1" }), null);
  assert.equal(mapFeedRow({ id: 3, url: "bad", apply_url: "https://apply.com/x" }).url, "https://apply.com/x");
});

test("chunk splits into <=100 by default", () => {
  const ids = Array.from({ length: 250 }, (_, i) => i);
  assert.deepEqual(chunk(ids).map((p) => p.length), [100, 100, 50]);
  assert.deepEqual(chunk([]), []);
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
});

test("inChunks concatenates and surfaces errors", async () => {
  const calls = [];
  const rows = await inChunks(Array.from({ length: 205 }, (_, i) => i), async (part) => {
    calls.push(part.length);
    return { data: part.map((x) => ({ x })) };
  });
  assert.deepEqual(calls, [100, 100, 5]);
  assert.equal(rows.length, 205);
  await assert.rejects(inChunks([1], async () => ({ error: new Error("boom") })), /boom/);
});

test("parseJobsQuery normalizes and accepts q or search", () => {
  const p = parseJobsQuery({ search: "  react  ", location: "Pune, Remote", seniority: "Senior,bogus", country: "us,in,zz9", posted_within: "99", sort: "x", page: "-3" });
  assert.equal(p.q, "react");
  assert.deepEqual(p.locations, ["Pune", "Remote"]);
  assert.deepEqual(p.seniority, ["senior"]);
  assert.deepEqual(p.country, ["US", "IN"]);
  assert.equal(p.hours, 31 * 24);
  assert.equal(p.sort, "newest");
  assert.equal(p.page, 1);
  assert.equal(parseJobsQuery({ q: "a", search: "b" }).q, "a");
  assert.equal(isUnfilteredQuery(parseJobsQuery({})), true);
  assert.equal(isUnfilteredQuery(parseJobsQuery({ page: "3", sort: "oldest" })), true);
  assert.equal(isUnfilteredQuery(parseJobsQuery({ source: "linkedin" })), false);
});

test("feedPageArgs sends NULL for absent filters", () => {
  const a = feedPageArgs(parseJobsQuery({ q: "go", company_type: "product" }), 20, 20);
  assert.deepEqual(a, {
    p_q: "go", p_company: null, p_location: null, p_location_type: null, p_seniority: null,
    p_source: null, p_country: null, p_company_type: ["product"], p_hours: null, p_offset: 20, p_limit: 20,
  });
  assert.equal(feedPageArgs(parseJobsQuery({ location: "A,B" }), 0, 20).p_location, "A|B");
});

test("cache key is stable and plan-specific", () => {
  const p1 = parseJobsQuery({ q: "x", page: "2", junk: "1" });
  const p2 = parseJobsQuery({ page: "2", q: "x" });
  assert.equal(jobsCacheKey("free", p1), jobsCacheKey("free", p2));
  assert.notEqual(jobsCacheKey("free", p1), jobsCacheKey("pro", p1));
});

test("escapeHtml / likeSafe", () => {
  assert.equal(escapeHtml('<img src=x onerror="a">&'), "&lt;img src=x onerror=&quot;a&quot;&gt;&amp;");
  assert.equal(likeSafe("a%b_c,(d)*"), "a b c d");
});

test("sanitizePostings keeps only http(s) links", () => {
  const out = sanitizePostings([{ id: 1, url: "https://a.com" }, { id: 2, url: "javascript:1" }, { id: 3 }]);
  assert.deepEqual(out.map((p) => p.id), [1]);
});

test("sendWithRetry retries 429 then succeeds; gives up on 400", async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const seq = [{ error: true, status: 429 }, { error: true, status: 429 }, { id: "ok" }];
  let i = 0;
  const r = await sendWithRetry(async () => seq[i++], { sleep, baseDelayMs: 10 });
  assert.equal(r.id, "ok");
  assert.deepEqual(sleeps, [10, 20]);
  let n = 0;
  const bad = await sendWithRetry(async () => { n++; return { error: true, status: 400 }; }, { sleep });
  assert.equal(n, 1);
  assert.equal(bad.status, 400);
});

test("createThrottle spaces calls", async () => {
  let t = 0;
  const slept = [];
  const wait = createThrottle(500, { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  await wait(); await wait(); await wait();
  assert.deepEqual(slept, [500, 500]);
});

test("mapWithConcurrency respects the limit and order", async () => {
  let active = 0, peak = 0;
  const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (x) => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return x * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
  assert.equal(peak, 2);
});

test("fetchAllPages pages past the row cap", async () => {
  const all = Array.from({ length: 2500 }, (_, i) => i);
  const rows = await fetchAllPages(async (from, to) => ({ data: all.slice(from, to + 1) }));
  assert.equal(rows.length, 2500);
});

test("rankFacet prefers prefix matches", () => {
  assert.deepEqual(rankFacet(["Stripe", "Strip Mall Inc", "Other"], "str", 2), ["Stripe", "Strip Mall Inc"]);
  assert.deepEqual(rankFacet(["a", "b"], "", 1), ["a"]);
});

test("resampleJobsSnapshots buckets ascending rows", () => {
  const pts = resampleJobsSnapshots([
    { snapshot_date: "2026-11-09", total_open: 10, new_postings: 2, closed_postings: 1 },
    { snapshot_date: "2026-11-10", total_open: 12, new_postings: 3, closed_postings: 0 },
    { snapshot_date: "2026-11-16", total_open: 20, new_postings: 1, closed_postings: 0 },
  ], "weekly");
  assert.equal(pts.length, 2);
  assert.equal(pts[0].totalOpen, 12);
  assert.equal(pts[0].newPostings, 5);
});

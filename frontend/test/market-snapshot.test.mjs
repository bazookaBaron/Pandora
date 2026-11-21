import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, runMarketSnapshots, loadMarketAnalytics, istDate } from "../lib/marketSnapshot.js";

const noSleep = async () => {};
function mockFetch(handler) {
  const calls = [];
  const f = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const r = handler(u, calls.length);
    return r || { ok: true, status: 200, json: async () => ({ count: 100, mean: 500000 }) };
  };
  f.calls = calls;
  return f;
}

test("buildSnapshot: 35 calls per country, shape, params", async () => {
  const f = mockFetch((u) => ({ ok: true, status: 200, json: async () => ({ count: u.searchParams.get("what") === "remote" ? 7 : 100, mean: 1234.4 }) }));
  const d = await buildSnapshot("IN", { appId: "a", appKey: "k", fetchImpl: f, sleep: noSleep });
  assert.equal(f.calls.length, 35);
  assert.equal(d.api_calls, 35);
  assert.equal(d.total, 100);
  assert.equal(d.mean_salary, 1234);
  assert.equal(Object.keys(d.roles).length, 20);
  assert.deepEqual(Object.keys(d.experience), ["entry", "mid", "senior", "leadership"]);
  assert.equal(d.work_mode.remote, 7);
  assert.equal(Object.keys(d.cities).length, 6);
  assert.ok(f.calls.every((u) => u.pathname.includes("/jobs/in/search/1") && u.searchParams.get("results_per_page") === "1"));
  assert.ok(f.calls.some((u) => u.searchParams.get("max_days_old") === "7"));
  assert.ok(f.calls.some((u) => u.searchParams.get("contract") === "1"));
  assert.ok(f.calls.some((u) => u.searchParams.get("where") === "Gurugram"));
});

test("buildSnapshot: retries on 429 then succeeds; total failure throws", async () => {
  let n = 0;
  const f = mockFetch(() => (++n === 1 ? { ok: false, status: 429, json: async () => ({}) } : null));
  const d = await buildSnapshot("US", { appId: "a", appKey: "k", fetchImpl: f, sleep: noSleep });
  assert.equal(d.total, 100);
  assert.equal(d.api_calls, 36); // one retry
  const bad = mockFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
  await assert.rejects(buildSnapshot("US", { appId: "a", appKey: "k", fetchImpl: bad, sleep: noSleep }));
  assert.equal(bad.calls.length, 4); // 1 + 3 backoff retries, then stop
});

test("buildSnapshot: failed sub-queries become null, extras add 2 calls", async () => {
  const f = mockFetch((u) => (u.searchParams.get("what") === "hybrid" ? { ok: false, status: 400, json: async () => ({}) } : null));
  const d = await buildSnapshot("IN", { appId: "a", appKey: "k", fetchImpl: f, sleep: noSleep, extras: true });
  assert.equal(d.work_mode.hybrid, null);
  assert.equal(d.api_calls, 37);
  assert.ok("new_1d" in d && "full_time" in d);
});

test("runMarketSnapshots: no-op without keys; skips when today's row exists", async () => {
  assert.deepEqual(await runMarketSnapshots({ supabase: null, env: {} }), { skipped: "no_adzuna_keys" });
  const f = mockFetch(() => null);
  const sb = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 1, data: { total: 5 }, created_at: new Date().toISOString() } }) }) }) }) }) };
  const r = await runMarketSnapshots({ supabase: sb, env: { ADZUNA_APP_ID: "a", ADZUNA_APP_KEY: "k" }, fetchImpl: f, sleep: noSleep });
  assert.deepEqual(r, { IN: "exists", US: "exists" });
  assert.equal(f.calls.length, 0);
});

test("istDate rolls over at 18:30 UTC", () => {
  assert.equal(istDate(new Date("2026-11-21T18:29:00Z")), "2026-11-21");
  assert.equal(istDate(new Date("2026-11-21T18:31:00Z")), "2026-11-22");
});

// Minimal in-memory market_snapshots table for the marker logic.
function memDb() {
  const rows = [];
  const b = (filters = {}, op = "select", payload) => {
    const api = {
      eq: (k, v) => b({ ...filters, [k]: v }, op, payload),
      maybeSingle: async () => ({ data: rows.find((r) => Object.entries(filters).every(([k, v]) => r[k] === v)) || null }),
      then: (res) => {
        const hit = rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
        if (op === "update") hit.forEach((r) => Object.assign(r, payload));
        if (op === "delete") hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
        res({ error: null });
      },
      select: () => api,
    };
    return api;
  };
  return {
    rows,
    from: () => ({
      select: () => b(),
      insert: async (r) => { rows.push({ id: rows.length + 1, created_at: new Date().toISOString(), ...r }); return { error: null }; },
      update: (p) => b({}, "update", p),
      delete: () => b({}, "delete"),
    }),
  };
}

test("failure leaves a marker, blocks retry for 6h, readers ignore it", async () => {
  const sb = memDb();
  const env = { ADZUNA_APP_ID: "a", ADZUNA_APP_KEY: "k" };
  const bad = mockFetch(() => ({ ok: false, status: 400, json: async () => ({}) }));
  const quiet = { error() {}, log() {} };
  const r1 = await runMarketSnapshots({ supabase: sb, env, fetchImpl: bad, sleep: noSleep, log: quiet });
  assert.deepEqual(r1, { IN: "error", US: "error" });
  assert.ok(sb.rows.every((r) => r.data.failed === true));
  const n = bad.calls.length;
  const r2 = await runMarketSnapshots({ supabase: sb, env, fetchImpl: bad, sleep: noSleep, log: quiet });
  assert.deepEqual(r2, { IN: "failed_recently", US: "failed_recently" });
  assert.equal(bad.calls.length, n);
  // after 6h it retries
  sb.rows.forEach((r) => { r.data.at = new Date(Date.now() - 7 * 3600000).toISOString(); });
  const good = mockFetch(() => null);
  const r3 = await runMarketSnapshots({ supabase: sb, env, fetchImpl: good, sleep: noSleep, log: quiet });
  assert.match(r3.IN, /^ok:/);
  const rd = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [{ taken_on: "2026-01-02", data: { failed: true, at: "x" } }, { taken_on: "2026-01-01", data: { pending: true } }] }) }) }) }) }) };
  assert.deepEqual(await loadMarketAnalytics(rd, "IN"), { ready: false, country: "IN" });
});

test("experience.mid has no bare digits; family params stay one call each", async () => {
  const { MARKET_CONFIG } = await import("../lib/marketSnapshot.js");
  assert.ok(MARKET_CONFIG.experience.mid.every((w) => !/\d/.test(w)));
  const f = mockFetch(() => null);
  await buildSnapshot("US", { appId: "a", appKey: "k", fetchImpl: f, sleep: noSleep });
  assert.equal(f.calls.length, 35);
  assert.ok(f.calls.some((u) => u.searchParams.get("what_and") === "sales"));
});

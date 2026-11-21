import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, runMarketSnapshots, istDate } from "../lib/marketSnapshot.js";

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

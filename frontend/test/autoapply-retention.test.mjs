/**
 * Task retention (sql/47_task_retention.sql + lib/autoapply/taskRetention.js): finished batches' not-applied task
 * rows go after 30 days, their counts live on in aa_batches.final_counts and the batch page still shows the same
 * numbers. Also: the refunded state is one short line with the amount only when it is > 0, and the stats page /
 * endpoint no longer carry a per-company table. In-memory fakes only; nothing leaves the process.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { createAutoApplyRouter } from "../routes/autoapply.js";
import { batchCounts, batchChargeSummary, chargeSummary, PRUNED_STATUSES } from "../lib/autoapply/insights.js";
import { buckets, liveStatus } from "../lib/autoapply/liveStatus.js";
import { cleanupOldTasks, TASK_RETENTION_DAYS, TASK_RETENTION_FN } from "../lib/autoapply/taskRetention.js";
import { createFakeDb } from "./fixtures/fakeSupabase.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), "utf8");

// ── counts merged with the snapshot ─────────────────────────────────────────
const snapshot = {
  v: 1,
  at: "2026-10-01T00:00:00Z",
  status: { applied: 3, skipped: 4, failed: 2, removed: 1, cancelled: 1, needs_you: 1 },
  reasons: [
    { status: "skipped", reason_code: "captcha", n: 3 },
    { status: "skipped", reason_code: null, n: 1 },
    { status: "failed", reason_code: "timeout", n: 2 },
    { status: "needs_you", reason_code: "sso_login", n: 1 },
  ],
};
const fullRows = [
  ...Array.from({ length: 3 }, () => ({ status: "applied" })),
  ...Array.from({ length: 3 }, () => ({ status: "skipped", reason_code: "captcha" })),
  { status: "skipped", reason_code: null },
  { status: "failed", reason_code: "timeout" },
  { status: "failed", reason_code: "timeout" },
  { status: "removed" },
  { status: "cancelled" },
  { status: "needs_you", reason_code: "sso_login" },
];
const afterRows = fullRows.filter((t) => !PRUNED_STATUSES.includes(t.status));

test("batchCounts: no snapshot = plain status counts; after deletion the snapshot keeps not-applied numbers", () => {
  const plain = batchCounts(fullRows, null);
  assert.deepEqual(plain, { applied: 3, skipped: 4, failed: 2, removed: 1, cancelled: 1, needs_you: 1 });
  assert.deepEqual(batchCounts(fullRows, snapshot), plain, "before any deletion the two agree");
  const merged = batchCounts(afterRows, snapshot);
  assert.deepEqual(merged, plain, "rows gone, numbers unchanged");
  assert.equal(buckets(merged).not_applied, 8);
  // applied / needs_you always come from the live rows (they are never deleted)
  assert.equal(batchCounts([{ status: "applied" }], { status: { applied: 99 } }).applied, 1);
  assert.deepEqual(batchCounts([], { status: "garbage" }), {});
});

test("batchChargeSummary: Not charged breakdown survives deletion, live numbers win when larger", () => {
  const before = chargeSummary(fullRows);
  assert.deepEqual(batchChargeSummary(fullRows, snapshot), before);
  assert.deepEqual(batchChargeSummary(afterRows, snapshot), before);
  assert.deepEqual(before, { applied: 3, not_charged: 7, in_progress: 0, by_reason: { failed: 2, captcha: 3, blocked: 1, other: 1 } });
  assert.deepEqual(batchChargeSummary(afterRows, null), chargeSummary(afterRows));
  assert.deepEqual(batchChargeSummary(fullRows, { reasons: [] }), before, "empty snapshot never lowers live numbers");
});

// ── refunded: one short line ────────────────────────────────────────────────
test("liveStatus refunded: amount only when > 0, one sentence", () => {
  const msg = (extra) => liveStatus({ batch: { status: "refunded", credits_total: 50, ...extra } }).message;
  assert.equal(msg({ refund_paise: 0 }), "This payment was refunded.");
  assert.equal(msg({ refund_paise: null }), "This payment was refunded.");
  assert.equal(msg({ refund_paise: 59900 }), "Refunded ₹599.");
  assert.doesNotMatch(msg({ refund_paise: 0 }), /₹0/);
  assert.equal(liveStatus({ batch: { status: "refunding", refund_paise: 0 } }).message, "This payment is being refunded.");
});

test("batch page: no ₹0 refund line, no confirmation-text snippet, no status column; stats page has no By company", () => {
  const page = read("../src/pages/autoapply/BatchDetailPage.jsx");
  assert.doesNotMatch(page, /for unused credits/);
  assert.match(page, /Number\(batch\.refund_paise\) > 0/);
  assert.doesNotMatch(page, /confirmation_text/);
  assert.doesNotMatch(page, /TaskStatusPill/);
  assert.match(page, /className="aa-tl"/);
  const stats = read("../src/pages/autoapply/StatsPage.jsx");
  assert.doesNotMatch(stats, /by_company|By company/);
});

// ── the retention loop ──────────────────────────────────────────────────────
function rpcDb(results) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      const next = results.shift();
      if (next instanceof Error) throw next;
      return next || { data: { processed: 0 }, error: null };
    },
  };
}

test("cleanupOldTasks: calls aa_task_retention in batches until a short batch, sums the results", async () => {
  const db = rpcDb([
    { data: { processed: 100, snapshots: 2, deleted: 60, slimmed: 40 }, error: null },
    { data: { processed: 100, snapshots: 1, deleted: 70, slimmed: 30 }, error: null },
    { data: { processed: 7, snapshots: 0, deleted: 7, slimmed: 0 }, error: null },
    { data: { processed: 100 }, error: null },
  ]);
  const r = await cleanupOldTasks({ db, chunk: 100 });
  assert.deepEqual(r, { calls: 3, processed: 207, snapshots: 3, deleted: 137, slimmed: 70 });
  assert.equal(db.calls.length, 3);
  assert.deepEqual(db.calls[0], { name: TASK_RETENTION_FN, args: { p_limit: 100, p_days: TASK_RETENTION_DAYS } });
  assert.equal(TASK_RETENTION_DAYS, 30);
});

test("cleanupOldTasks: bounded calls, clamped chunk, never throws, missing migration skipped", async () => {
  const busy = rpcDb(Array.from({ length: 10 }, () => ({ data: { processed: 2000 }, error: null })));
  const r = await cleanupOldTasks({ db: busy, chunk: 999999, maxCalls: 3 });
  assert.equal(r.calls, 3);
  assert.equal(busy.calls[0].args.p_limit, 2000, "never more than 2000 rows per transaction");

  const missing = rpcDb([{ data: null, error: { code: "PGRST202", message: "Could not find the function public.aa_task_retention" } }]);
  assert.equal((await cleanupOldTasks({ db: missing })).skipped, "not_installed");

  const broken = rpcDb([{ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }]);
  assert.equal((await cleanupOldTasks({ db: broken })).error, true);
  const thrown = rpcDb([new Error("network down")]);
  assert.equal((await cleanupOldTasks({ db: thrown })).error, true);
});

// ── the migration ───────────────────────────────────────────────────────────
test("sql/47: final_counts column, finished batches only, batched with SKIP LOCKED, proof_path untouched", () => {
  const sql = read("../../sql/47_task_retention.sql");
  const body = sql.replace(/--.*$/gm, "");
  assert.match(body, /ALTER TABLE public\.aa_batches ADD COLUMN IF NOT EXISTS final_counts jsonb/);
  assert.match(body, /b\.status IN \('completed', 'expired', 'refunded', 'cancelled'\)/);
  for (const open of ["paid", "shortlisting", "review", "running", "paused", "waiting_supply", "waiting_profile", "refund_due", "refunding"]) {
    assert.doesNotMatch(body.match(/b\.status IN \([^)]*\)/)[0], new RegExp(`'${open}'`), `${open} batches are skipped`);
  }
  assert.match(body, /LIMIT lim/);
  assert.match(body, /FOR UPDATE OF t, b SKIP LOCKED/);
  assert.match(body, /LEAST\(GREATEST\(COALESCE\(p_limit, 500\), 1\), 2000\)/);
  assert.match(body, /GREATEST\(COALESCE\(p_days, 30\), 30\)/, "the window can never be shorter than 30 days");
  assert.match(body, /t\.updated_at < cutoff/);
  assert.match(body, /DELETE FROM public\.aa_tasks\s+WHERE id = ANY \(ids\)\s+AND status IN \('skipped', 'failed', 'cancelled'\)\s+AND updated_at < del_cut/);
  assert.match(body, /SET evidence = '\{\}'::jsonb, confirmation_text = NULL, reason_detail = NULL, artifacts_prefix = NULL/);
  assert.doesNotMatch(body, /proof_path/, "proof retention owns proof_path");
  assert.ok(body.indexOf("SET final_counts") < body.indexOf("DELETE FROM public.aa_tasks"), "counts are stored before rows are deleted");
  assert.match(body, /AND b\.final_counts IS NULL/, "snapshot taken once");
  assert.match(body, /REVOKE ALL ON FUNCTION public\.aa_task_retention\(integer, integer\) FROM PUBLIC/);
});

// ── the batch page API with a pruned batch ─────────────────────────────────
const U1 = "cccccccc-0000-4000-8000-000000000001";
const DONE = crypto.randomUUID();
const OPEN = crypto.randomUUID();
const db = createFakeDb({
  aa_batches: [
    { id: DONE, user_id: U1, pack_kind: "product", pack_size: 50, credits_total: 3, credits_used: 3, status: "completed", purchased_at: "2026-09-01T00:00:00Z", final_counts: snapshot },
    { id: OPEN, user_id: U1, pack_kind: "product", pack_size: 50, credits_total: 50, credits_used: 0, status: "running", purchased_at: "2026-11-20T00:00:00Z" },
  ],
  aa_tasks: [
    ...afterRows.map((t, i) => ({ ...t, id: crypto.randomUUID(), batch_id: DONE, user_id: U1, company: `Co${i}`, title: "Backend Engineer", score: 10 - i, submitted_at: t.status === "applied" ? "2026-09-02T00:00:00Z" : null })),
    { id: crypto.randomUUID(), batch_id: OPEN, user_id: U1, company: "Fresh", title: "SRE", status: "skipped", reason_code: "closed", score: 1 },
  ],
});
let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/autoapply", createAutoApplyRouter({
    db,
    mailDb: createFakeDb({}),
    razorpay: { isEnabled: () => false, keyId: () => "" },
    env: {},
    getUserPlan: async () => "pro",
    authenticate: (req, _res, next) => { req.user = { id: U1, email: "u1@mail.test", email_confirmed: true }; next(); },
  }));
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test("GET /batches/:id: a pruned finished batch shows the same counts as before the deletion", async () => {
  const res = await fetch(`${base}/api/autoapply/batches/${DONE}`, { headers: { Authorization: "Bearer x" } });
  const j = await res.json();
  assert.equal(res.status, 200, JSON.stringify(j));
  assert.deepEqual(j.counts, { applied: 3, skipped: 4, failed: 2, removed: 1, cancelled: 1, needs_you: 1 });
  assert.equal(j.live.buckets.not_applied, 8);
  assert.deepEqual(j.charge, chargeSummary(fullRows));
  assert.equal("final_counts" in j.batch, false, "internal snapshot not sent to the browser");
  assert.equal(j.tasks.length, afterRows.length);

  const open = await (await fetch(`${base}/api/autoapply/batches/${OPEN}`, { headers: { Authorization: "Bearer x" } })).json();
  assert.equal(open.counts.skipped, 1, "open batch: live rows only");
});

import test from "node:test";
import assert from "node:assert/strict";
import { buckets, liveStatus, engineState } from "../lib/autoapply/liveStatus.js";

const now = new Date("2026-11-24T06:00:00Z");
const run = (counts, extra = {}) => liveStatus({ batch: { status: "running", credits_total: 50, credits_used: 0 }, counts, now, ...extra });

test("buckets group task statuses", () => {
  assert.deepEqual(buckets({ queued: 3, shortlisted: 1, running: 1, submitting: 1, applied: 4, needs_you: 2, skipped: 1, failed: 1 }),
    { queued: 4, applying: 2, applied: 4, needs_you: 2, not_applied: 2 });
});

test("applying now wins", () => {
  const s = run({ queued: 5, running: 2 });
  assert.equal(s.phase, "applying");
  assert.match(s.message, /Applying now: 2 applications/);
});

test("engine starting", () => {
  assert.match(run({ queued: 5 }, { engine: "starting" }).message, /Starting our application server/);
});

test("spaced out until a later time", () => {
  assert.match(run({ queued: 5 }, { nextAt: "2026-11-24T09:00:00Z" }).message, /Next application at about .*IST/);
});

test("queued and due", () => {
  assert.match(run({ queued: 5 }, { nextAt: "2026-11-24T05:00:00Z" }).message, /start within about 40 minutes/);
  assert.match(run({ queued: 5 }, { engine: "running" }).message, /next applications start in a few minutes/);
});

test("other batch states", () => {
  const st = (status, extra = {}) => liveStatus({ batch: { status, credits_total: 50, ...extra }, counts: { applied: 7 }, now }).message;
  assert.match(st("waiting_profile"), /profile is complete/);
  assert.match(st("review"), /approve/);
  assert.match(st("completed"), /7 applications submitted/);
  assert.match(st("refunded"), /refunded/);
  assert.match(st("paused", { cancel_requested_at: now.toISOString() }), /Cancelling/);
  assert.match(st("waiting_supply"), /new matching jobs/);
});

test("engineState never throws", async () => {
  const bad = { from: () => { throw new Error("x"); } };
  assert.equal(await engineState(bad), "off");
  const ok = { from: () => ({ select: () => ({ in: () => ({ order: () => ({ limit: async () => ({ data: [{ status: "running" }], error: null }) }) }) }) }) };
  assert.equal(await engineState(ok), "running");
});

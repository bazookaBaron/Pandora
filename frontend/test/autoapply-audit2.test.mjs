/**
 * Audit fixes (round 2): push endpoint allowlist, coupons redeemed at capture, cancel with in-flight /
 * verify_submission tasks, zero-amount refunds without Razorpay, no-refund policy (expiry extension), proof retention.
 * Run: npm run test:autoapply
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";

import { createAutoApplyRouter } from "../routes/autoapply.js";
import { isAllowedPushEndpoint } from "../lib/autoapply/push.js";
import { createAutoApplyOrder, markBatchPaid, COUPON_UNAVAILABLE_NOTE } from "../lib/autoapply/orders.js";
import { processRefunds, extendUnfulfilled } from "../lib/autoapply/refunds.js";
import { cleanupOldProofs } from "../lib/autoapply/proofRetention.js";
import { createFakeDb } from "./fixtures/fakeSupabase.mjs";

const U1 = "ffffffff-0000-4000-8000-000000000001";
const NOW = new Date();
const DAY = 86400000;
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

test("push endpoint allowlist: known push services only, no IP literals / http / ports / creds", () => {
  for (const ok of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://wns2-par02p.notify.windows.com/w/?token=x",
    "https://web.push.apple.com/QGx",
  ]) assert.equal(isAllowedPushEndpoint(ok), true, ok);
  for (const no of [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x",
    "https://fcm.googleapis.com:8443/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://evil.com/fcm.googleapis.com",
    "https://fcm.googleapis.com.evil.com/x",
    "https://push.services.mozilla.com/x",
    "https://evilpush.services.mozilla.com/x",
    "https://localhost/x",
    "not a url",
    null,
  ]) assert.equal(isAllowedPushEndpoint(no), false, String(no));
});

// ── coupons: per_job_rupee redeemed only at capture ───────────────────────
function couponDb({ uses = 0, maxUses = 1 } = {}) {
  const db = createFakeDb({ aa_profiles: [{ user_id: U1, consent_at: NOW.toISOString() }] });
  const state = { uses, maxUses, redemptions: [] };
  db.rpc = async (name, args) => {
    if (name === "redeem_coupon") {
      if (state.uses >= state.maxUses && !args.p_dry) return { data: null, error: { message: "coupon_used_up" } };
      if (state.uses >= state.maxUses && args.p_dry) return { data: null, error: { message: "coupon_used_up" } };
      if (args.p_dry) return { data: [{ redemption_id: null, kind: "per_job_rupee", plan: "max" }], error: null };
      state.uses++;
      const id = crypto.randomUUID();
      state.redemptions.push(id);
      return { data: [{ redemption_id: id, kind: "per_job_rupee", plan: "max" }], error: null };
    }
    if (name === "release_coupon") {
      state.uses = Math.max(0, state.uses - 1);
      state.redemptions = state.redemptions.filter((r) => r !== args.p_redemption);
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };
  return { db, state };
}
const rz = {
  isEnabled: () => true,
  keyId: () => "rzp_test",
  async createOrder(o) { return { id: `order_${crypto.randomUUID().slice(0, 8)}`, amount: o.amountPaise, currency: "INR" }; },
};

test("per_job_rupee coupon: not redeemed at order creation, redeemed on capture (once, verify + webhook)", async () => {
  const { db, state } = couponDb();
  const order = await createAutoApplyOrder({ db, razorpay: rz, getUserPlan: async () => "pro", userId: U1, body: { pack_kind: "product", pack_size: 50, coupon_code: "RUPEE" }, now: NOW });
  assert.equal(order.amount, 5000);
  assert.equal(state.uses, 0, "an open checkout does not use the coupon");
  const batch = db.rows("aa_batches")[0];
  assert.equal(batch.coupon_code, "RUPEE");
  assert.equal(batch.coupon_redemption_id ?? null, null);
  const paid = await markBatchPaid({ db, batch, paymentId: "pay_1", now: NOW });
  assert.equal(paid.status, "paid");
  assert.equal(state.uses, 1);
  assert.ok(paid.coupon_redemption_id);
  await markBatchPaid({ db, batch, paymentId: "pay_1", now: NOW }); // webhook replay
  assert.equal(state.uses, 1, "replay does not redeem twice");
});

test("per_job_rupee coupon used up by the time the payment lands -> refund_due in full", async () => {
  const { db, state } = couponDb();
  await createAutoApplyOrder({ db, razorpay: rz, getUserPlan: async () => "pro", userId: U1, body: { pack_kind: "product", pack_size: 50, coupon_code: "RUPEE" }, now: NOW });
  state.uses = 1; // someone else's capture took the last use
  const out = await markBatchPaid({ db, batch: db.rows("aa_batches")[0], paymentId: "pay_2", now: NOW });
  assert.equal(out.status, "refund_due");
  assert.equal(db.rows("aa_credit_ledger")[0].note, COUPON_UNAVAILABLE_NOTE);
});

test("free (price 0) coupon pack still redeems immediately", async () => {
  const db = createFakeDb({ aa_profiles: [{ user_id: U1, consent_at: NOW.toISOString() }] });
  let redeemed = 0;
  db.rpc = async (name, args) => {
    if (name === "redeem_coupon") {
      if (!args.p_dry) redeemed++;
      return { data: [{ redemption_id: args.p_dry ? null : crypto.randomUUID(), kind: "free_all", plan: "max" }], error: null };
    }
    return { data: null, error: null };
  };
  const r = await createAutoApplyOrder({ db, razorpay: { isEnabled: () => false }, getUserPlan: async () => "free", userId: U1, body: { pack_kind: "product", pack_size: 50, coupon_code: "FREE" }, now: NOW });
  assert.equal(r.free, true);
  assert.equal(redeemed, 1);
  assert.equal(db.rows("aa_batches")[0].status, "paid");
});

// ── refunds without Razorpay ───────────────────────────────────────────────
test("refunds: zero-amount coupon batch is processed with Razorpay off; a paid one waits", async () => {
  // admin-approved refunds (the only refunds of a started batch the policy allows)
  const free = { id: crypto.randomUUID(), user_id: U1, price_paise: 0, credits_total: 50, credits_used: 10, status: "refund_due", purchased_at: ago(DAY), razorpay_payment_id: "coupon_x", refund_approved_at: ago(1000) };
  const paid = { id: crypto.randomUUID(), user_id: U1, price_paise: 59900, credits_total: 50, credits_used: 10, status: "refund_due", purchased_at: ago(DAY), razorpay_payment_id: "pay_x", refund_approved_at: ago(1000) };
  const db = createFakeDb({ aa_batches: [free, paid] });
  const out = await processRefunds({ db, razorpay: { isEnabled: () => false }, now: NOW });
  assert.ok(!out.disabled);
  const rows = db.rows("aa_batches");
  assert.equal(rows.find((b) => b.id === free.id).status, "refunded");
  assert.equal(rows.find((b) => b.id === paid.id).status, "refund_due");
  assert.deepEqual(db.rows("aa_credit_ledger").map((l) => [l.batch_id, l.delta]), [[free.id, -40]]);
});

// ── no give-up: unfulfilled batches are kept alive ──────────────────────────
test("waiting_supply / expiry: never refunded; expires_at pushed forward while credits are left", async () => {
  const soon = { id: crypto.randomUUID(), user_id: U1, credits_total: 50, credits_used: 3, status: "waiting_supply", purchased_at: ago(88 * DAY), expires_at: new Date(NOW.getTime() + DAY).toISOString() };
  const past = { id: crypto.randomUUID(), user_id: U1, credits_total: 50, credits_used: 0, status: "running", purchased_at: ago(95 * DAY), expires_at: ago(DAY) };
  const full = { id: crypto.randomUUID(), user_id: U1, credits_total: 50, credits_used: 50, status: "running", purchased_at: ago(95 * DAY), expires_at: ago(DAY) };
  const far = { id: crypto.randomUUID(), user_id: U1, credits_total: 50, credits_used: 3, status: "running", purchased_at: ago(DAY), expires_at: new Date(NOW.getTime() + 80 * DAY).toISOString() };
  const db = createFakeDb({ aa_batches: [soon, past, full, far] });
  const out = await extendUnfulfilled({ db, now: NOW });
  assert.deepEqual(out.map((o) => o.batch_id).sort(), [soon.id, past.id].sort());
  const rows = Object.fromEntries(db.rows("aa_batches").map((b) => [b.id, b]));
  for (const id of [soon.id, past.id]) assert.ok(Date.parse(rows[id].expires_at) >= NOW.getTime() + 6.9 * DAY, "extended ~7 days");
  assert.equal(rows[full.id].expires_at, full.expires_at);
  assert.equal(rows[far.id].expires_at, far.expires_at);
  // the refunds pass never moves any of them toward a refund
  await processRefunds({ db, razorpay: { isEnabled: () => true }, now: NOW });
  assert.deepEqual(db.rows("aa_batches").map((b) => b.status).sort(), ["running", "running", "running", "waiting_supply"]);
  assert.equal(db.rows("aa_credit_ledger").length, 0);
});

// ── proof retention ────────────────────────────────────────────────────────
test("proof retention: >30 day proofs deleted + proof_path nulled, confirmation_text kept", async () => {
  const oldT = { id: crypto.randomUUID(), user_id: U1, status: "applied", submitted_at: ago(31 * DAY), proof_path: `${U1}/a.jpg`, confirmation_text: "Thanks!" };
  const newT = { id: crypto.randomUUID(), user_id: U1, status: "applied", submitted_at: ago(5 * DAY), proof_path: `${U1}/b.jpg` };
  const db = createFakeDb({ aa_tasks: [oldT, newT] });
  const r = await cleanupOldProofs({ db, now: NOW });
  assert.deepEqual(r, { removed: 1, failed: 0 });
  const rows = db.rows("aa_tasks");
  assert.equal(rows.find((t) => t.id === oldT.id).proof_path, null);
  assert.equal(rows.find((t) => t.id === oldT.id).confirmation_text, "Thanks!");
  assert.equal(rows.find((t) => t.id === newT.id).proof_path, `${U1}/b.jpg`);
  assert.deepEqual(db.storage.calls.find((c) => c.op === "remove").paths, [`${U1}/a.jpg`]);
});

// ── cancel route ───────────────────────────────────────────────────────────
let server, base, db;
before(async () => {
  db = createFakeDb({});
  const app = express();
  app.use(express.json());
  app.use("/api/autoapply", createAutoApplyRouter({
      legacyPacks: true,
    db,
    mailDb: createFakeDb(),
    razorpay: { isEnabled: () => true },
    getUserPlan: async () => "pro",
    authenticate: (req, _res, next) => { req.user = { id: U1, email: "x@mail.test" }; next(); },
  }));
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test("cancel of a paid batch = pause: no task touched, no refund, resumable", async () => {
  const b = { id: crypto.randomUUID(), user_id: U1, credits_total: 50, credits_used: 5, status: "running", purchased_at: ago(DAY), price_paise: 59900 };
  db.rows("aa_batches").push({ ...b, created_at: ago(DAY), updated_at: ago(DAY) });
  const verify = { id: crypto.randomUUID(), batch_id: b.id, user_id: U1, status: "needs_you", reason_code: "verify_submission" };
  const captcha = { id: crypto.randomUUID(), batch_id: b.id, user_id: U1, status: "needs_you", reason_code: "captcha" };
  db.rows("aa_tasks").push(verify, captcha);
  const res = await fetch(`${base}/api/autoapply/batches/${b.id}/cancel`, { method: "POST", headers: { Authorization: "Bearer x" } });
  const j = await res.json();
  assert.equal(res.status, 200, JSON.stringify(j));
  assert.equal(j.batch.status, "paused");
  assert.equal(j.paused, true);
  const st = Object.fromEntries(db.rows("aa_tasks").map((t) => [t.id, t.status]));
  assert.equal(st[verify.id], "needs_you");
  assert.equal(st[captcha.id], "needs_you");
  const again = await fetch(`${base}/api/autoapply/batches/${b.id}/cancel`, { method: "POST", headers: { Authorization: "Bearer x" } });
  assert.equal(again.status, 200, "double click is fine");
  const r = await fetch(`${base}/api/autoapply/batches/${b.id}/resume`, { method: "POST", headers: { Authorization: "Bearer x" } });
  assert.equal((await r.json()).batch.status, "running");
});

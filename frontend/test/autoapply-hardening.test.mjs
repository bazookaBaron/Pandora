/**
 * AutoApply audit fixes: late / over-cap payments, multi-replica refund claims, pending-order expiry, consent,
 * retry-safe mutations, push endpoint ownership, re-auth for password reveal, mail authentication + retention.
 * Run: npm run test:autoapply
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";

import { createAutoApplyRouter, authAgeS } from "../routes/autoapply.js";
import { markBatchPaid, expirePendingOrders, LATE_PAYMENT_NOTE, CAP_OVERFLOW_NOTE } from "../lib/autoapply/orders.js";
import { processRefunds, STALE_CLAIM_MS } from "../lib/autoapply/refunds.js";
import { monthPurchased } from "../lib/autoapply/limits.js";
import { mailAuthOk } from "../lib/autoapply/inbound.js";
import { createFakeDb } from "./fixtures/fakeSupabase.mjs";

const U1 = "dddddddd-0000-4000-8000-000000000001";
const U2 = "dddddddd-0000-4000-8000-000000000002";
const NOW = new Date();
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60 * 1000;

function fakeRazorpay() {
  const refunds = [];
  return {
    refunds,
    isEnabled: () => true,
    async listRefunds(pid) { return refunds.filter((r) => r.payment_id === pid); },
    async refundPayment(pid, { amountPaise, notes }) {
      const r = { id: `rfnd_${refunds.length + 1}`, payment_id: pid, amount: amountPaise, notes };
      refunds.push(r);
      return r;
    },
  };
}

// ── 1. payments that land on an unpaid batch ───────────────────────────────
test("markBatchPaid: payment for a cancelled unpaid batch -> refund_due with a ledger note, then refunded in full", async () => {
  const b = { id: crypto.randomUUID(), user_id: U1, pack_kind: "product", pack_size: 50, price_paise: 59900, credits_total: 50, status: "cancelled" };
  const db = createFakeDb({ aa_batches: [b] });
  const out = await markBatchPaid({ db, batch: b, paymentId: "pay_late", now: NOW });
  assert.equal(out.status, "refund_due");
  assert.ok(out.purchased_at);
  assert.equal(out.razorpay_payment_id, "pay_late");
  const led = db.rows("aa_credit_ledger");
  assert.equal(led.length, 1);
  assert.deepEqual([led[0].reason, led[0].delta, led[0].note], ["purchase", 50, LATE_PAYMENT_NOTE]);
  // idempotent replay (webhook after verify): no second ledger row, status unchanged
  const again = await markBatchPaid({ db, batch: b, paymentId: "pay_late", now: NOW });
  assert.equal(again.status, "refund_due");
  assert.equal(db.rows("aa_credit_ledger").length, 1);

  const rz = fakeRazorpay();
  await processRefunds({ db, razorpay: rz });
  assert.equal(rz.refunds.length, 1);
  assert.equal(rz.refunds[0].amount, 59900, "full refund");
  assert.equal(db.rows("aa_batches")[0].status, "refunded");
  assert.equal(db.rows("aa_credit_ledger").reduce((s, r) => s + r.delta, 0), 0, "ledger balances");
});

test("markBatchPaid: a pending batch that would break the monthly cap is auto-refunded, not activated", async () => {
  const full = { id: crypto.randomUUID(), user_id: U1, pack_kind: "service", pack_size: 100, price_paise: 99900, credits_total: 980, status: "running", purchased_at: ago(MIN) };
  const b = { id: crypto.randomUUID(), user_id: U1, pack_kind: "product", pack_size: 50, price_paise: 59900, credits_total: 50, status: "pending_payment" };
  const db = createFakeDb({ aa_batches: [full, b] });
  const out = await markBatchPaid({ db, batch: b, paymentId: "pay_over", now: NOW });
  assert.equal(out.status, "refund_due");
  assert.equal(db.rows("aa_credit_ledger")[0].note, CAP_OVERFLOW_NOTE);
  // within the cap it is simply paid, and the ledger note is absent
  const db2 = createFakeDb({ aa_batches: [{ ...b }] });
  const ok = await markBatchPaid({ db: db2, batch: b, paymentId: "pay_ok", now: NOW });
  assert.equal(ok.status, "paid");
  assert.equal(db2.rows("aa_credit_ledger")[0].note, undefined);
});

// ── 4. monthly cap counting ─────────────────────────────────────────────────
test("monthPurchased: refunded batches count only used credits; fresh pending orders count when asked", async () => {
  const db = createFakeDb({
    aa_batches: [
      { user_id: U1, credits_total: 100, credits_used: 0, status: "running", purchased_at: ago(MIN) },
      { user_id: U1, credits_total: 100, credits_used: 30, status: "refunded", purchased_at: ago(MIN) },
      { user_id: U1, credits_total: 50, credits_used: 5, status: "refund_due", purchased_at: ago(MIN) },
      { user_id: U1, credits_total: 50, status: "pending_payment", created_at: ago(5 * MIN) },
      { user_id: U1, credits_total: 50, status: "pending_payment", created_at: ago(60 * MIN) },
      { user_id: U2, credits_total: 500, status: "running", purchased_at: ago(MIN) },
    ],
  });
  assert.equal(await monthPurchased(db, U1, NOW), 135);
  assert.equal(await monthPurchased(db, U1, NOW, { includePending: true }), 185, "only the order from the last 30 min holds credits");
});

// ── 2/3. refund claims ──────────────────────────────────────────────────────
test("refunds: a batch claimed by another replica is skipped; a stale claim is taken over; no payment -> cancelled", async () => {
  const mine = { id: crypto.randomUUID(), user_id: U1, price_paise: 10000, credits_total: 10, credits_used: 0, status: "refund_due", purchased_at: ago(MIN), razorpay_payment_id: "pay_a" };
  const busy = { id: crypto.randomUUID(), user_id: U1, price_paise: 10000, credits_total: 10, credits_used: 0, status: "refunding", purchased_at: ago(MIN), razorpay_payment_id: "pay_b", updated_at: ago(MIN) };
  const stale = { id: crypto.randomUUID(), user_id: U1, price_paise: 10000, credits_total: 10, credits_used: 0, status: "refunding", purchased_at: ago(MIN), razorpay_payment_id: "pay_c", updated_at: ago(STALE_CLAIM_MS + MIN) };
  const unpaid = { id: crypto.randomUUID(), user_id: U1, price_paise: 10000, credits_total: 10, credits_used: 0, status: "refund_due", purchased_at: null, razorpay_payment_id: null };
  const db = createFakeDb({ aa_batches: [mine, busy, stale, unpaid] });
  const rz = fakeRazorpay();
  const r = await processRefunds({ db, razorpay: rz, now: NOW });
  const st = (id) => db.rows("aa_batches").find((x) => x.id === id).status;
  assert.equal(st(mine.id), "refunded");
  assert.equal(st(busy.id), "refunding", "a fresh claim belongs to the other replica");
  assert.equal(st(stale.id), "refunded", "a claim older than 30 min is taken over");
  assert.equal(st(unpaid.id), "cancelled", "nothing paid: out of the refund queue, not retried every 15 min");
  assert.deepEqual(rz.refunds.map((x) => x.payment_id).sort(), ["pay_a", "pay_c"]);
  assert.ok(r.results.some((x) => x.cancelled === "no_payment_id"));
});

test("refunds: in-flight tasks release the claim; credits_used is re-read after the in-flight check", async () => {
  const b = { id: crypto.randomUUID(), user_id: U1, price_paise: 10000, credits_total: 10, credits_used: 0, status: "refund_due", purchased_at: ago(MIN), razorpay_payment_id: "pay_x" };
  const task = { id: crypto.randomUUID(), batch_id: b.id, user_id: U1, status: "running" };
  const db = createFakeDb({ aa_batches: [b], aa_tasks: [task] });
  const rz = fakeRazorpay();
  await processRefunds({ db, razorpay: rz, now: NOW });
  assert.equal(db.rows("aa_batches")[0].status, "refund_due", "released back to the queue");
  assert.equal(rz.refunds.length, 0);

  // the task captures a credit while the next pass runs: the capture lands right after the in-flight count
  db.rows("aa_tasks")[0].status = "applied";
  const from = db.from;
  db.from = (t) => {
    const qb = from(t);
    if (t === "aa_tasks") {
      const then = qb.then;
      qb.then = (res, rej) => then.call(qb, (v) => { db.rows("aa_batches")[0].credits_used = 4; return res(v); }, rej);
    }
    return qb;
  };
  await processRefunds({ db, razorpay: rz, now: NOW });
  db.from = from;
  assert.equal(rz.refunds.length, 1);
  assert.equal(rz.refunds[0].amount, 6000, "6 of 10 credits refunded, not 10");
  assert.equal(db.rows("aa_credit_ledger").find((l) => l.reason === "refund").delta, -6);
});

// ── 8. pending order expiry ─────────────────────────────────────────────────
test("expirePendingOrders: pending_payment older than 24 h -> cancelled; fresh and paid untouched", async () => {
  const db = createFakeDb({
    aa_batches: [
      { id: "old", user_id: U1, credits_total: 50, status: "pending_payment", created_at: ago(25 * 60 * MIN) },
      { id: "new", user_id: U1, credits_total: 50, status: "pending_payment", created_at: ago(60 * MIN) },
      { id: "paid", user_id: U1, credits_total: 50, status: "paid", purchased_at: ago(MIN), created_at: ago(48 * 60 * MIN) },
    ],
  });
  assert.deepEqual(await expirePendingOrders({ db, now: NOW }), { expired: 1 });
  assert.deepEqual(db.rows("aa_batches").map((x) => x.status), ["cancelled", "pending_payment", "paid"]);
});

// ── 9. mail authentication ──────────────────────────────────────────────────
test("mailAuthOk: DMARC pass, or aligned DKIM without a DMARC verdict; SPF alone never", () => {
  assert.equal(mailAuthOk({ from: "a@acme.com", auth: { dmarc: "pass" } }), true);
  assert.equal(mailAuthOk({ from: "a@acme.com", auth: { dmarc: "fail", dkim: "pass", dkim_domains: ["acme.com"] } }), false);
  assert.equal(mailAuthOk({ from: "a@mail.acme.com", auth: { dkim: "pass", dkim_domains: ["acme.com"] } }), true);
  assert.equal(mailAuthOk({ from: "a@acme.com", auth: { dmarc: "none", dkim: "pass", dkim_domains: ["evil.test"] } }), false);
  assert.equal(mailAuthOk({ from: "a@acme.com", auth: { spf: "pass" } }), false);
  assert.equal(mailAuthOk({ from: "a@acme.com" }), false, "no verdict (old worker) is unauthenticated");
});

test("authAgeS uses the newest amr timestamp, never iat", () => {
  const tok = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  const nowS = Date.UTC(2026, 10, 21) / 1000;
  const nowMs = nowS * 1000;
  // refreshed token (fresh iat) over an old sign-in: still old
  assert.equal(authAgeS(tok({ iat: nowS, amr: [{ method: "oauth", timestamp: nowS - 3600 }] }), nowMs), 3600);
  // the newest of several methods counts (e.g. password then a recent reauthentication)
  assert.equal(authAgeS(tok({ iat: nowS, amr: [{ method: "password", timestamp: nowS - 7200 }, { method: "otp", timestamp: nowS - 30 }] }), nowMs), 30);
  assert.equal(authAgeS(tok({ iat: nowS }), nowMs), null, "no amr -> unknown");
  assert.equal(authAgeS(tok({ iat: nowS, amr: [{ method: "password" }] }), nowMs), null);
  assert.equal(authAgeS("garbage", nowMs), null);
  assert.equal(authAgeS(undefined, nowMs), null);
});

// ── API: consent, retry-safe mutations, push ownership, read-all ────────────
const db = createFakeDb({
  aa_profiles: [{ user_id: U2, apply_alias: "two.zzzz", consent_at: new Date().toISOString(), onboarding_done: true }],
  aa_push_subscriptions: [{ user_id: U2, endpoint: "https://updates.push.services.mozilla.com/wpush/v2/dev-2", p256dh: "k2", auth: "a2" }],
});
const mailDb = createFakeDb();
const orders = [];
const razorpay = { ...fakeRazorpay(), keyId: () => "rzp_test", async createOrder(o) { const r = { id: `order_${orders.length + 1}`, amount: o.amountPaise, currency: o.currency, notes: o.notes }; orders.push(r); return r; } };
let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/autoapply",
    createAutoApplyRouter({
      db,
      mailDb,
      razorpay,
      getUserPlan: async () => "pro",
      authenticate: (req, res, next) => {
        const uid = String(req.headers.authorization || "").replace(/^Bearer /, "");
        if (![U1, U2].includes(uid)) return res.status(401).json({ error: { code: "auth_required", message: "x" } });
        req.user = { id: uid, email: "x@mail.test" };
        next();
      },
    }),
  );
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

async function call(method, path, { user = U1, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${user}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test("consent: no order and no finished onboarding without consent_at", async () => {
  const o = await call("POST", "/api/autoapply/orders", { body: { pack_kind: "product", pack_size: 50 } });
  assert.equal(o.status, 403);
  assert.equal(o.json.error.code, "consent_required");
  assert.equal(orders.length, 0, "no Razorpay order was created");
  const p = await call("PUT", "/api/autoapply/profile", { body: { onboarding_done: true } });
  assert.equal(p.status, 400);
  assert.equal(p.json.error.code, "consent_required");
  const ok = await call("PUT", "/api/autoapply/profile", { body: { onboarding_done: true, consent: true } });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.profile.consent_at && ok.json.profile.onboarding_done);
  const o2 = await call("POST", "/api/autoapply/orders", { body: { pack_kind: "product", pack_size: 50 } });
  assert.equal(o2.status, 200, JSON.stringify(o2.json));
});

test("approve: a retry after the batch flipped re-queues the tasks and returns 200", async () => {
  const b = { id: crypto.randomUUID(), user_id: U1, pack_kind: "product", pack_size: 50, credits_total: 50, status: "running", review_until: ago(MIN), purchased_at: ago(MIN) };
  db.rows("aa_batches").push(b);
  const t = { id: crypto.randomUUID(), batch_id: b.id, user_id: U1, status: "shortlisted" };
  db.rows("aa_tasks").push(t);
  const r = await call("POST", `/api/autoapply/batches/${b.id}/approve`);
  assert.equal(r.status, 200);
  assert.equal(r.json.batch.id, b.id);
  assert.equal(db.rows("aa_tasks").find((x) => x.id === t.id).status, "queued");
  b.review_until = null; // a running batch that was never approved is still not approvable
  assert.equal((await call("POST", `/api/autoapply/batches/${b.id}/approve`)).status, 409);
});

test("cancel: tasks are cancelled before the batch flips; a retry is a 200 that finishes the clean-up", async () => {
  const b = { id: crypto.randomUUID(), user_id: U1, pack_kind: "product", pack_size: 50, credits_total: 50, credits_used: 2, status: "running", purchased_at: ago(MIN) };
  db.rows("aa_batches").push(b);
  const t = { id: crypto.randomUUID(), batch_id: b.id, user_id: U1, status: "queued" };
  db.rows("aa_tasks").push(t);
  const r = await call("POST", `/api/autoapply/batches/${b.id}/cancel`);
  assert.equal(r.status, 200);
  assert.equal(r.json.batch.status, "refund_due");
  assert.equal(db.rows("aa_tasks").find((x) => x.id === t.id).status, "cancelled");
  // simulate a partial earlier run: batch already refund_due, a needs-you item still open
  const ny = { id: crypto.randomUUID(), task_id: t.id, user_id: U1, kind: "captcha", resolved_at: null };
  db.rows("aa_needs_you").push(ny);
  const again = await call("POST", `/api/autoapply/batches/${b.id}/cancel`);
  assert.equal(again.status, 200);
  assert.equal(again.json.batch.status, "refund_due");
  assert.equal(db.rows("aa_needs_you").find((x) => x.id === ny.id).resolution, "expired");
});

test("needs-you: a failed answer write leaves the item open, so the retry succeeds", async () => {
  const t = { id: crypto.randomUUID(), batch_id: crypto.randomUUID(), user_id: U1, status: "needs_you" };
  db.rows("aa_tasks").push(t);
  const ny = { id: crypto.randomUUID(), task_id: t.id, user_id: U1, kind: "question", payload: { question: "Notice period in days?" }, resolved_at: null };
  db.rows("aa_needs_you").push(ny);
  const from = db.from;
  db.from = (name) => {
    const qb = from(name);
    if (name === "aa_answers") qb.then = (res) => Promise.resolve({ data: null, error: { message: "boom" } }).then(res);
    return qb;
  };
  const fail = await call("POST", `/api/autoapply/needs-you/${ny.id}`, { body: { action: "answer", answer: "30" } });
  db.from = from;
  assert.equal(fail.status, 500);
  assert.equal(db.rows("aa_needs_you").find((x) => x.id === ny.id).resolved_at, null, "still open after the failure");
  const ok = await call("POST", `/api/autoapply/needs-you/${ny.id}`, { body: { action: "answer", answer: "30" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.item.resolution, "answered");
  assert.equal(db.rows("aa_tasks").find((x) => x.id === t.id).status, "queued");
});

test("push/subscribe never reassigns another user's device; returns the subscription", async () => {
  const stolen = await call("POST", "/api/autoapply/push/subscribe", { body: { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/dev-2", keys: { p256dh: "evil", auth: "evil" } } });
  assert.equal(stolen.status, 409);
  assert.equal(stolen.json.error.code, "endpoint_owned");
  const row = db.rows("aa_push_subscriptions").find((x) => x.endpoint === "https://updates.push.services.mozilla.com/wpush/v2/dev-2");
  assert.deepEqual([row.user_id, row.p256dh], [U2, "k2"]);
  const mine = await call("POST", "/api/autoapply/push/subscribe", { body: { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/dev-1", keys: { p256dh: "k1", auth: "a1" } } });
  assert.equal(mine.status, 200);
  assert.equal(mine.json.subscription.endpoint, "https://updates.push.services.mozilla.com/wpush/v2/dev-1");
  const refresh = await call("POST", "/api/autoapply/push/subscribe", { body: { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/dev-1", keys: { p256dh: "k1b", auth: "a1" } } });
  assert.equal(refresh.status, 200);
  assert.equal(db.rows("aa_push_subscriptions").find((x) => x.endpoint === "https://updates.push.services.mozilla.com/wpush/v2/dev-1").p256dh, "k1b");
});

test("inbox: unread count via head count; read-all returns how many it marked", async () => {
  for (let i = 0; i < 3; i++) mailDb.rows("aa_mail_events").push({ id: 7000 + i, user_id: U1, category: "important", kind: "interview", read_at: null, received_at: ago(i * MIN) });
  mailDb.rows("aa_mail_events").push({ id: 7100, user_id: U2, category: "important", read_at: null, received_at: ago(MIN) });
  const u = await call("GET", "/api/autoapply/inbox/unread");
  assert.deepEqual(u.json, { count: 3, by_kind: { interview: 3 } });
  const r = await call("POST", "/api/autoapply/inbox/read-all");
  assert.deepEqual(r.json, { ok: true, count: 3 });
  assert.equal((await call("GET", "/api/autoapply/inbox/unread")).json.count, 0);
});

// ── verify_submission items (worker lease expired while submitting) ────────
function verifyFixture({ batchStatus = "running", used = 0, total = 50 } = {}) {
  const b = { id: crypto.randomUUID(), user_id: U1, pack_kind: "product", pack_size: 50, credits_total: total, credits_used: used, status: batchStatus, purchased_at: ago(MIN) };
  const t = { id: crypto.randomUUID(), batch_id: b.id, user_id: U1, company: "Acme", title: "SDE", status: "needs_you", reason_code: "verify_submission", attempt: 1, claimed_by: "w1", lease_until: ago(MIN) };
  const ny = { id: crypto.randomUUID(), task_id: t.id, user_id: U1, kind: "other", payload: { reason: "verify_submission", apply_url: "https://acme.test/job" }, resolved_at: null };
  db.rows("aa_batches").push(b);
  db.rows("aa_tasks").push(t);
  db.rows("aa_needs_you").push(ny);
  const get = () => ({ b: db.rows("aa_batches").find((x) => x.id === b.id), t: db.rows("aa_tasks").find((x) => x.id === t.id), caps: db.rows("aa_credit_ledger").filter((l) => l.task_id === t.id && l.reason === "capture") });
  return { b, t, ny, get };
}

test("verify: confirm_submitted -> applied, one credit captured exactly once (retry safe)", async () => {
  const f = verifyFixture();
  const r = await call("POST", `/api/autoapply/needs-you/${f.ny.id}`, { body: { action: "confirm_submitted" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.item.resolution, "done_by_user");
  assert.equal(r.json.task.status, "applied");
  const { b, t, caps } = f.get();
  assert.equal(t.status, "applied");
  assert.ok(t.submitted_at);
  assert.equal(t.lease_until, null);
  assert.equal(caps.length, 1);
  assert.equal(caps[0].delta, -1);
  assert.equal(b.credits_used, 1);
  const again = await call("POST", `/api/autoapply/needs-you/${f.ny.id}`, { body: { action: "confirm_submitted" } });
  assert.equal(again.status, 200);
  assert.equal(f.get().caps.length, 1, "no second capture");
  assert.equal(f.get().b.credits_used, 1);
});

test("verify: confirm on the last credit completes the batch; refund states record applied without a credit", async () => {
  const last = verifyFixture({ used: 49 });
  await call("POST", `/api/autoapply/needs-you/${last.ny.id}`, { body: { action: "confirm_submitted" } });
  assert.equal(last.get().b.status, "completed");
  for (const st of ["refund_due", "refunding", "refunded"]) {
    const f = verifyFixture({ batchStatus: st, used: 3 });
    const r = await call("POST", `/api/autoapply/needs-you/${f.ny.id}`, { body: { action: "confirm_submitted" } });
    assert.equal(r.status, 200);
    const { b, t, caps } = f.get();
    assert.equal(t.status, "applied", st);
    assert.equal(caps.length, 0, `${st}: no credit`);
    assert.equal(b.credits_used, 3, `${st}: credits_used unchanged`);
    assert.equal(b.status, st);
  }
});

test("verify: not_submitted requeues (attempt+1, lease cleared) while credits remain, else skipped", async () => {
  const f = verifyFixture();
  const r = await call("POST", `/api/autoapply/needs-you/${f.ny.id}`, { body: { action: "not_submitted" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.item.resolution, "dismissed");
  const { t, caps } = f.get();
  assert.deepEqual([t.status, t.attempt, t.claimed_by, t.lease_until, t.reason_code], ["queued", 2, null, null, null]);
  assert.equal(caps.length, 0);
  for (const opts of [{ batchStatus: "paused" }, { batchStatus: "running", used: 50 }, { batchStatus: "refund_due" }]) {
    const g = verifyFixture(opts);
    await call("POST", `/api/autoapply/needs-you/${g.ny.id}`, { body: { action: "not_submitted" } });
    assert.equal(g.get().t.status, "skipped", JSON.stringify(opts));
    assert.equal(g.get().t.reason_code, "not_submitted");
  }
  const w = verifyFixture({ batchStatus: "waiting_supply" });
  await call("POST", `/api/autoapply/needs-you/${w.ny.id}`, { body: { action: "not_submitted" } });
  assert.equal(w.get().t.status, "queued");
});

test("verify actions only for verify_submission items; verify items refuse done / answer", async () => {
  const t = { id: crypto.randomUUID(), batch_id: crypto.randomUUID(), user_id: U1, status: "needs_you" };
  const cap = { id: crypto.randomUUID(), task_id: t.id, user_id: U1, kind: "captcha", payload: { apply_url: "https://x" }, resolved_at: null };
  db.rows("aa_tasks").push(t);
  db.rows("aa_needs_you").push(cap);
  const r = await call("POST", `/api/autoapply/needs-you/${cap.id}`, { body: { action: "confirm_submitted" } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "invalid_action");
  assert.equal(db.rows("aa_tasks").find((x) => x.id === t.id).status, "needs_you");
  const f = verifyFixture();
  const d = await call("POST", `/api/autoapply/needs-you/${f.ny.id}`, { body: { action: "done" } });
  assert.equal(d.status, 409);
  assert.equal(f.get().t.status, "needs_you");
  assert.equal((await call("POST", `/api/autoapply/needs-you/${f.ny.id}`, { body: { action: "bogus" } })).status, 400);
});

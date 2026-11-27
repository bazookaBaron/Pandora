/**
 * No-refund policy + consolidated needs-you form + payment / coupon audit fixes.
 * Run: npm run test:autoapply
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";

import { createAutoApplyRouter, runAutoApplyRefunds, runNeedsYouJobs } from "../routes/autoapply.js";
import { learnedKey } from "../lib/autoapply/questions.js";
import { buildForm, publicForm, parseSubmission, derivedAnswer, canonicalFor, notifyReadyNeedsYou, expireFinalBatchNeedsYou, READY_AFTER_MS } from "../lib/autoapply/needsYouForm.js";
import { liveStatus } from "../lib/autoapply/liveStatus.js";
import { refundAllowed, finalizeCancelRequests } from "../lib/autoapply/refunds.js";
import { createAutoApplyOrder, verifyAutoApplyPayment, handleAutoApplyWebhook, markBatchPaid, CAP_OVERFLOW_NOTE } from "../lib/autoapply/orders.js";
import { createFakeDb } from "./fixtures/fakeSupabase.mjs";

const U = "dddddddd-0000-4000-8000-000000000001";
const ADMIN = "dddddddd-0000-4000-8000-0000000000ad";
const NOW = new Date();
const DAY = 86400000;
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const q = (task, label, extra = {}) => ({ id: crypto.randomUUID(), task_id: task.id, user_id: U, kind: "question", payload: { question: label, question_key: learnedKey(label), ...extra }, created_at: ago(1000) });

// ── pure form building ─────────────────────────────────────────────────────
test("buildForm: DOB parts collapse into one date field; same question across jobs dedupes; controls", () => {
  const t1 = { id: "t1", company: "Acme", ats: "workday" };
  const t2 = { id: "t2", company: "Beta", ats: "greenhouse" };
  const items = [
    q(t1, "Date of Birth - Day", { options: ["1", "2", "15", "31"] }),
    q(t1, "Date of Birth - Month", { options: ["January", "February", "March"] }),
    q(t1, "Date of Birth - Year"),
    q(t2, "Date of birth"),
    q(t1, "Are you willing to work from our Pune office?", { options: ["Yes", "No"] }),
    q(t2, "Are you willing to work from our Pune office?", { options: ["Yes", "No"] }),
    q(t2, "Which shift do you prefer?", { options: ["Day", "Night"] }),
    q(t2, "Describe a project you are proud of"),
    { id: "v1", task_id: "t1", kind: "account", payload: { note: "Please verify your email address to continue", apply_url: "https://acme.wd3.myworkdayjobs.com/x" } },
    { id: "v2", task_id: "t2", kind: "captcha", payload: { apply_url: "https://boards.greenhouse.io/beta/1" } },
    { id: "u1", task_id: "t2", kind: "other", payload: { reason: "verify_submission" } },
  ];
  const tasks = new Map([[t1.id, t1], [t2.id, t2]]);
  const form = buildForm(items, tasks, {});
  const byKey = Object.fromEntries(form.fields.map((f) => [f.key, f]));
  assert.ok(byKey["facts.date_of_birth"], "one DOB field");
  assert.equal(byKey["facts.date_of_birth"].type, "date");
  assert.equal(byKey["facts.date_of_birth"].sources.length, 4);
  const wfo = byKey[learnedKey("Are you willing to work from our Pune office?")];
  assert.equal(wfo.type, "yesno");
  assert.equal(wfo.item_ids.length, 2, "deduped across two jobs");
  assert.deepEqual(wfo.companies, ["Acme", "Beta"]);
  assert.equal(byKey[learnedKey("Which shift do you prefer?")].type, "select");
  assert.equal(byKey[learnedKey("Describe a project you are proud of")].type, "textarea");
  assert.equal(form.fields.length, 4);
  assert.equal(form.sites.length, 2);
  assert.equal(form.sites.find((s) => s.kind === "verify_email").title, "Verify your account email on workday");
  assert.equal(form.sites.find((s) => s.kind === "manual").jobs.length, 1);
  assert.deepEqual(form.unconfirmed.map((u) => u.item_id), ["u1"]);
  const pub = publicForm(form);
  assert.ok(pub.fields.every((f) => !("sources" in f) && !("item_ids" in f) && f.count >= 1));
});

test("derivedAnswer maps a DOB onto day / month / year questions in the site's own option spelling", () => {
  assert.equal(derivedAnswer("1995-03-15", { part: "day", options: ["1", "15"] }), "15");
  assert.equal(derivedAnswer("1995-03-15", { part: "month", options: ["January", "March"] }), "March");
  assert.equal(derivedAnswer("1995-03-15", { part: "month", options: ["Jan", "Mar"] }), "Mar");
  assert.equal(derivedAnswer("1995-03-15", { part: "month", options: [] }), "03");
  assert.equal(derivedAnswer("1995-03-15", { part: "year", options: [] }), "1995");
  assert.equal(derivedAnswer("yes", { part: null, options: ["Yes", "No"] }), "Yes");
  assert.equal(derivedAnswer("maybe", { part: null, options: ["Yes", "No"] }), null);
  assert.equal(canonicalFor("First Name").key, "fields.first_name");
  assert.equal(canonicalFor("First Name", ["A"]).key, learnedKey("First Name"), "a question with choices stays learned");
});

test("parseSubmission: unknown ids, bad options, over-long text and bad dates are rejected (400)", () => {
  const t = { id: "t", company: "Acme" };
  const items = [q(t, "Which shift do you prefer?", { options: ["Day", "Night"] }), q(t, "Tell us about yourself"), q(t, "Date of Birth")];
  const form = buildForm(items, new Map([["t", t]]), {});
  const shift = learnedKey("Which shift do you prefer?");
  const about = learnedKey("Tell us about yourself");
  const bad = (body) => assert.throws(() => parseSubmission(form, body), (e) => e.status === 400);
  bad(null);
  bad({ answers: { "q.0000000000000000": "x" } });
  bad({ answers: { [shift]: "Evening" } });
  bad({ answers: { [about]: "x".repeat(2001) } });
  bad({ answers: { "facts.date_of_birth": "15/03/1995" } });
  bad({ answers: [] });
  bad({ sites: { "nope": "done" } });
  bad({ unconfirmed: { x: "maybe" } });
  const ok = parseSubmission(form, { answers: { [shift]: "night", [about]: "  Builder  ", "facts.date_of_birth": "" } });
  assert.deepEqual(ok.answers, [{ key: shift, value: "Night" }, { key: about, value: "Builder" }]);
});

// ── API ────────────────────────────────────────────────────────────────────
let server, base, db, pushes;
before(async () => {
  db = createFakeDb({});
  pushes = [];
  const app = express();
  app.use(express.json());
  app.use("/api/autoapply", createAutoApplyRouter({
    db,
    mailDb: createFakeDb(),
    env: { AA_ADMIN_USER_IDS: ADMIN },
    razorpay: { isEnabled: () => true },
    getUserPlan: async () => "pro",
    authenticate: (req, _res, next) => { req.user = { id: req.headers["x-user"] || U, email: "x@mail.test" }; next(); },
  }));
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

async function call(method, path, body, user = U) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "x-user": user }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function seedBatch(extra = {}) {
  const b = { id: crypto.randomUUID(), user_id: U, pack_kind: "product", pack_size: 50, price_paise: 59900, credits_total: 50, credits_used: 10, status: "running", purchased_at: ago(DAY), razorpay_payment_id: `pay_${crypto.randomBytes(3).toString("hex")}`, expires_at: new Date(NOW.getTime() + 60 * DAY).toISOString(), ...extra };
  db.rows("aa_batches").push(b);
  return b;
}
function seedTask(b, status, extra = {}) {
  const t = { id: crypto.randomUUID(), batch_id: b.id, user_id: U, status, company: `Co${db.rows("aa_tasks").length}`, title: "Engineer", ats: "greenhouse", apply_url: "https://boards.greenhouse.io/x/1", ...extra };
  db.rows("aa_tasks").push(t);
  return t;
}

test("needs-you accumulates silently while the batch works, then shows as ONE form; Save answers + re-queues", async () => {
  const b = seedBatch();
  const ta = seedTask(b, "needs_you");
  const tb = seedTask(b, "needs_you");
  const busy = seedTask(b, "queued");
  const label = "Are you willing to work from our Pune office?";
  const n1 = q(ta, label, { options: ["Yes", "No"] });
  const n2 = q(tb, label, { options: ["Yes", "No"] });
  const n3 = q(tb, "Date of Birth - Year");
  for (const n of [n1, n2, n3]) db.rows("aa_needs_you").push({ ...n, batch_id: n === n3 ? null : b.id, resolved_at: null });

  let f = await call("GET", "/api/autoapply/needs-you/form");
  assert.equal(f.status, 200);
  assert.equal(f.json.fields.length, 0, "hidden while the batch still has work queued");
  assert.equal(f.json.accumulating, 3);
  assert.equal((await call("GET", "/api/autoapply/needs-you")).json.items.length, 0);

  busy.status = "applied";
  f = await call("GET", "/api/autoapply/needs-you/form");
  assert.equal(f.json.accumulating, 0);
  assert.equal(f.json.fields.length, 2, "Pune question deduped + DOB");
  const wfo = f.json.fields.find((x) => x.id === learnedKey(label));
  assert.equal(wfo.count, 2);

  // too long / unknown -> 400, nothing saved
  const badRes = await call("POST", "/api/autoapply/needs-you/form", { answers: { [learnedKey(label)]: "Perhaps" } });
  assert.equal(badRes.status, 400);
  assert.equal(badRes.json.error.code, "invalid_input");

  // answer only the Pune question: task A re-queued; task B still lacks its DOB -> stays needs_you
  const s1 = await call("POST", "/api/autoapply/needs-you/form", { answers: { [learnedKey(label)]: "yes" } });
  assert.equal(s1.status, 200, JSON.stringify(s1.json));
  assert.equal(db.rows("aa_answers").find((r) => r.question_key === learnedKey(label)).answer, "Yes");
  assert.equal(ta.status, "queued");
  assert.ok(ta.not_before);
  assert.equal(tb.status, "needs_you");
  assert.equal(s1.json.result.requeued, 1);
  assert.equal(db.rows("aa_needs_you").find((n) => n.id === n1.id).resolution, "answered");
  assert.equal(db.rows("aa_needs_you").find((n) => n.id === n2.id).resolved_at, null);

  // now the DOB: canonical facts.date_of_birth + the derived year under the item's own key
  const s2 = await call("POST", "/api/autoapply/needs-you/form", { answers: { "facts.date_of_birth": "1995-03-15" } });
  assert.equal(s2.status, 200, JSON.stringify(s2.json));
  const ans = Object.fromEntries(db.rows("aa_answers").map((r) => [r.question_key, r.answer]));
  assert.equal(ans["facts.date_of_birth"], "1995-03-15");
  assert.equal(ans[learnedKey("Date of Birth - Year")], "1995");
  assert.equal(tb.status, "queued");
  assert.equal(s2.json.fields.length, 0);
});

test("needs-you form: verify-email site retries its jobs; manual 'applied' skips with no credit; unconfirmed yes/no", async () => {
  const b = seedBatch({ status: "waiting_supply" });
  const ta = seedTask(b, "needs_you");
  const tb = seedTask(b, "needs_you");
  const tc = seedTask(b, "needs_you", { reason_code: "verify_submission" });
  const td = seedTask(b, "needs_you", { reason_code: "verify_submission" });
  const items = [
    { id: crypto.randomUUID(), task_id: ta.id, batch_id: b.id, user_id: U, kind: "account", payload: { note: "Verify your email to activate the account" }, created_at: ago(1000), resolved_at: null },
    { id: crypto.randomUUID(), task_id: tb.id, batch_id: b.id, user_id: U, kind: "captcha", payload: {}, created_at: ago(1000), resolved_at: null },
    { id: crypto.randomUUID(), task_id: tc.id, batch_id: b.id, user_id: U, kind: "other", payload: { reason: "verify_submission" }, created_at: ago(1000), resolved_at: null },
    { id: crypto.randomUUID(), task_id: td.id, batch_id: b.id, user_id: U, kind: "other", payload: { reason: "verify_submission" }, created_at: ago(1000), resolved_at: null },
  ];
  db.rows("aa_needs_you").push(...items);
  const f = await call("GET", "/api/autoapply/needs-you/form");
  const site = f.json.sites.find((s) => s.kind === "verify_email");
  assert.ok(site);
  const used = b.credits_used;
  const r = await call("POST", "/api/autoapply/needs-you/form", {
    sites: { [site.id]: "done" },
    manual: { [items[1].id]: "applied" },
    unconfirmed: { [items[2].id]: "yes", [items[3].id]: "no" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(ta.status, "queued");
  assert.equal(tb.status, "skipped");
  assert.equal(tb.reason_code, "done_by_user");
  assert.equal(tc.status, "applied");
  assert.equal(db.rows("aa_batches").find((x) => x.id === b.id).credits_used, used + 1, "confirmed one = one credit");
  assert.equal(td.status, "queued", "not submitted: retried while credits are left");
  assert.ok(items.every((i) => db.rows("aa_needs_you").find((n) => n.id === i.id).resolved_at));
});

test("old items show even while the batch works (scheduler expires them at 7 days)", async () => {
  const b = seedBatch();
  seedTask(b, "queued");
  const t = seedTask(b, "needs_you");
  const old = { ...q(t, "Old question?"), batch_id: b.id, created_at: ago(READY_AFTER_MS + 1000), resolved_at: null };
  db.rows("aa_needs_you").push(old);
  const f = await call("GET", "/api/autoapply/needs-you/form");
  assert.ok(f.json.fields.some((x) => x.id === learnedKey("Old question?")));
  db.rows("aa_needs_you").find((n) => n.id === old.id).resolved_at = ago(0);
});

test("notify: ONE push per batch once it is ready, never per item, never twice", async () => {
  const ndb = createFakeDb({});
  const b = { id: crypto.randomUUID(), user_id: U, status: "running", credits_total: 50, credits_used: 1 };
  ndb.rows("aa_batches").push(b);
  const t1 = { id: crypto.randomUUID(), batch_id: b.id, user_id: U, status: "needs_you" };
  const t2 = { id: crypto.randomUUID(), batch_id: b.id, user_id: U, status: "queued" };
  ndb.rows("aa_tasks").push(t1, t2);
  ndb.rows("aa_needs_you").push({ id: crypto.randomUUID(), task_id: t1.id, batch_id: null, user_id: U, kind: "question", payload: {}, resolved_at: null, created_at: ago(1000) });
  ndb.rows("aa_needs_you").push({ id: crypto.randomUUID(), task_id: t1.id, batch_id: b.id, user_id: U, kind: "question", payload: {}, resolved_at: null, created_at: ago(1000) });
  const sent = [];
  const send = async (a) => { sent.push(a); return { sent: 1 }; };
  assert.equal((await notifyReadyNeedsYou({ db: ndb, send, now: NOW })).sent, 0, "still working: silent");
  t2.status = "applied";
  assert.equal((await notifyReadyNeedsYou({ db: ndb, send, now: NOW })).sent, 1);
  assert.equal((await notifyReadyNeedsYou({ db: ndb, send, now: NOW })).sent, 0, "never twice");
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.body, /2 applications need/);
  assert.equal(sent[0].payload.url, "/autoapply/needs-you");
});

test("hygiene: a final batch's open items (batch_id NULL too) expire and their needs_you tasks are skipped; verify kept", async () => {
  const hdb = createFakeDb({});
  const fin = { id: crypto.randomUUID(), user_id: U, status: "completed", credits_total: 50, credits_used: 50 };
  const live = { id: crypto.randomUUID(), user_id: U, status: "running", credits_total: 50, credits_used: 5 };
  hdb.rows("aa_batches").push(fin, live);
  const t1 = { id: crypto.randomUUID(), batch_id: fin.id, user_id: U, status: "needs_you", reason_code: "unanswered_required" };
  const t2 = { id: crypto.randomUUID(), batch_id: fin.id, user_id: U, status: "needs_you", reason_code: "verify_submission" };
  const t3 = { id: crypto.randomUUID(), batch_id: live.id, user_id: U, status: "needs_you" };
  hdb.rows("aa_tasks").push(t1, t2, t3);
  const i1 = { id: crypto.randomUUID(), task_id: t1.id, batch_id: null, user_id: U, kind: "question", payload: {}, resolved_at: null };
  const i2 = { id: crypto.randomUUID(), task_id: t2.id, batch_id: null, user_id: U, kind: "other", payload: { reason: "verify_submission" }, resolved_at: null };
  const i3 = { id: crypto.randomUUID(), task_id: t3.id, batch_id: null, user_id: U, kind: "question", payload: {}, resolved_at: null };
  hdb.rows("aa_needs_you").push(i1, i2, i3);
  const r = await expireFinalBatchNeedsYou({ db: hdb, now: NOW });
  assert.deepEqual(r, { items: 1, tasks: 1 });
  assert.equal(hdb.rows("aa_needs_you").find((n) => n.id === i1.id).resolution, "expired");
  assert.equal(t1.status, "skipped");
  assert.equal(t2.status, "needs_you");
  assert.equal(hdb.rows("aa_needs_you").find((n) => n.id === i2.id).resolved_at, null);
  assert.equal(t3.status, "needs_you");
  const j = await runNeedsYouJobs({ db: hdb, now: NOW, send: async () => ({ sent: 1 }) });
  assert.ok(j.expired && j.notified);
});

// ── refunds: admin only ─────────────────────────────────────────────────────
test("admin refund: users get 403; an admin queues it; the cron refunds the unused share pro rata", async () => {
  const b = seedBatch({ credits_used: 20 });
  const t = seedTask(b, "queued");
  assert.equal((await call("POST", `/api/autoapply/admin/batches/${b.id}/refund`, { reason: "payment error", confirm: true })).status, 403);
  assert.equal((await call("POST", `/api/autoapply/admin/batches/${b.id}/refund`, { reason: "x", confirm: true }, ADMIN)).status, 400);
  assert.equal((await call("POST", `/api/autoapply/admin/batches/${b.id}/refund`, { reason: "duplicate charge" }, ADMIN)).status, 400, "needs confirm");
  const r = await call("POST", `/api/autoapply/admin/batches/${b.id}/refund`, { reason: "duplicate charge by the bank", confirm: true }, ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.batch.status, "refund_due");
  assert.ok(r.json.batch.refund_approved_at);
  assert.equal(t.status, "cancelled");
  const refunds = [];
  const rz = {
    isEnabled: () => true,
    listRefunds: async () => refunds,
    refundPayment: async (pid, { amountPaise, notes }) => { const x = { id: `rf_${refunds.length}`, amount: amountPaise, notes }; refunds.push(x); return x; },
  };
  await runAutoApplyRefunds({ db, razorpay: rz });
  const row = db.rows("aa_batches").find((x) => x.id === b.id);
  assert.equal(row.status, "refunded");
  assert.equal(refunds[0].amount, Math.floor((59900 * 30) / 50));
});

test("refundAllowed: admin or payment-safety only; legacy parked cancels become plain pauses", async () => {
  const pdb = createFakeDb({});
  assert.equal(await refundAllowed(pdb, { id: "a", refund_approved_at: ago(0) }), "admin");
  assert.equal(await refundAllowed(pdb, { id: "b", refund_reason: CAP_OVERFLOW_NOTE }), "payment_safety");
  pdb.rows("aa_credit_ledger").push({ batch_id: "c", reason: "purchase", note: "late_payment_auto_refund" });
  assert.equal(await refundAllowed(pdb, { id: "c" }), "payment_safety");
  assert.equal(await refundAllowed(pdb, { id: "d", credits_used: 0 }), null, "never started is not enough");
  pdb.rows("aa_batches").push({ id: "p", status: "paused", cancel_requested_at: ago(DAY) });
  await finalizeCancelRequests({ db: pdb });
  assert.equal(pdb.rows("aa_batches")[0].status, "paused");
  assert.equal(pdb.rows("aa_batches")[0].cancel_requested_at, null);
});

test("markBatchPaid marks payment-safety refunds explicitly (refund_reason)", async () => {
  const mdb = createFakeDb({});
  const b = { id: crypto.randomUUID(), user_id: U, pack_kind: "product", pack_size: 50, price_paise: 59900, credits_total: 50, status: "cancelled" };
  mdb.rows("aa_batches").push(b);
  const out = await markBatchPaid({ db: mdb, batch: b, paymentId: "pay_late", now: NOW });
  assert.equal(out.status, "refund_due");
  assert.equal(out.refund_reason, "late_payment_auto_refund");
});

test("liveStatus copy: we keep going until all N applications are submitted; no refund promises", () => {
  for (const st of ["waiting_supply", "paused", "running"]) {
    const m = liveStatus({ batch: { status: st, credits_total: 50, credits_used: 3 } }).message;
    assert.match(m, /until all 50 applications are submitted/, st);
    assert.doesNotMatch(m, /refund/i, st);
  }
  assert.doesNotMatch(liveStatus({ batch: { status: "paused", cancel_requested_at: ago(0), credits_total: 50 } }).message, /refund/i);
});

// ── payments / coupons audit ───────────────────────────────────────────────
test("verify fails closed when Razorpay returns no order (503, nothing recorded)", async () => {
  const vdb = createFakeDb({});
  const b = { id: crypto.randomUUID(), user_id: U, price_paise: 59900, credits_total: 50, status: "pending_payment", razorpay_order_id: "order_1" };
  vdb.rows("aa_batches").push(b);
  const rz = { isEnabled: () => true, verifyPaymentSignature: () => true, fetchOrder: async () => null };
  await assert.rejects(
    verifyAutoApplyPayment({ db: vdb, razorpay: rz, userId: U, body: { razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: "s" } }),
    (e) => e.status === 503 && e.code === "order_unverified",
  );
  assert.equal(vdb.rows("aa_batches")[0].status, "pending_payment");
});

test("webhook amount mismatch is recorded for manual review, once", async () => {
  const wdb = createFakeDb({});
  const b = { id: crypto.randomUUID(), user_id: U, price_paise: 59900, credits_total: 50, status: "pending_payment", razorpay_order_id: "order_w" };
  wdb.rows("aa_batches").push(b);
  const body = { event: "payment.captured", payload: { payment: { entity: { id: "pay_w", order_id: "order_w", amount: 100, currency: "INR", notes: { kind: "autoapply" } } } } };
  const r = await handleAutoApplyWebhook({ db: wdb, body });
  assert.match(r.note, /amount mismatch/);
  await handleAutoApplyWebhook({ db: wdb, body });
  const rows = wdb.rows("aa_payment_reviews");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "amount_mismatch");
  assert.equal(rows[0].paid_paise, 100);
  assert.equal(rows[0].expected_paise, 59900);
  assert.equal(wdb.rows("aa_batches")[0].status, "pending_payment");
});

test("free_all coupon covers packs up to 50 unless the coupon row allows more", async () => {
  const cdb = createFakeDb({ aa_profiles: [{ user_id: U, consent_at: NOW.toISOString() }] });
  let maxPack = undefined;
  let redeemed = 0;
  cdb.rpc = async (name, args) => {
    if (name === "redeem_coupon") {
      if (!args.p_dry) redeemed++;
      return { data: [{ redemption_id: args.p_dry ? null : crypto.randomUUID(), kind: "free_all", plan: "max", max_pack_size: maxPack }], error: null };
    }
    return { data: null, error: null };
  };
  const order = (size) => createAutoApplyOrder({ db: cdb, razorpay: { isEnabled: () => false }, getUserPlan: async () => "free", userId: U, body: { pack_kind: "product", pack_size: size, coupon_code: "FREE" }, now: NOW });
  await assert.rejects(order(100), (e) => e.code === "coupon_not_applicable");
  assert.equal(redeemed, 0);
  assert.equal((await order(50)).free, true);
  maxPack = 100;
  assert.equal((await order(100)).free, true);
});

test("buildForm: payload.input_type picks the control; repeats across jobs count once per job and show their jobs", () => {
  const t1 = { id: "t1", company: "Acme", title: "SDE 2", ats: "workday" };
  const t2 = { id: "t2", company: "Beta", title: "Backend Engineer", ats: "greenhouse" };
  const skills = ["Python", "Go", "Rust"];
  const items = [
    q(t1, "Which of these do you know?", { options: skills, input_type: "multiselect", required: true }),
    q(t2, "Which of these do you know?", { options: skills, input_type: "multiselect" }),
    q(t1, "Work mode", { options: ["Onsite", "Remote", "Hybrid"], input_type: "radio" }),
    q(t1, "Notice period", { options: ["15 days", "30 days"], input_type: "select" }),
    q(t1, "Why do you want this job?", { input_type: "text" }),
    q(t1, "Expected CTC", { input_type: "number" }),
    q(t1, "I agree to the terms", { input_type: "checkbox" }),
    q(t2, "Legacy question with options", { options: ["A", "B"] }),
  ];
  const form = buildForm(items, new Map([[t1.id, t1], [t2.id, t2]]), {});
  const by = (label) => form.fields.find((f) => f.label === label);
  const skillF = by("Which of these do you know?");
  assert.equal(skillF.type, "multiselect");
  assert.equal(skillF.required, true);
  assert.equal(skillF.job_count, 2);
  assert.deepEqual(skillF.jobs, [{ company: "Acme", title: "SDE 2" }, { company: "Beta", title: "Backend Engineer" }]);
  assert.equal(by("Work mode").type, "radio");
  assert.equal(by("Notice period").type, "select");
  assert.equal(by("Why do you want this job?").type, "text", "worker-reported single-line input beats the 'why' heuristic");
  assert.equal(by("Expected CTC").type, "number");
  assert.equal(by("I agree to the terms").type, "yesno");
  assert.equal(by("Legacy question with options").type, "select", "no input_type: old heuristics");
  // multiselect answers must come from the site's options
  const id = skillF.id;
  assert.throws(() => parseSubmission(form, { answers: { [id]: "Python,Cobol" } }), /choose from the options/);
  const ok = parseSubmission(form, { answers: { [id]: "python, Go" } });
  assert.ok(ok.answers.some((a) => a.value === "Python,Go"));
});

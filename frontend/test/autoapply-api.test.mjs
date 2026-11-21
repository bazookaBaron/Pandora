/**
 * AutoApply HTTP API tests: the real router + inbound handler mounted on a
 * throwaway Express app, with an in-memory Supabase fake and fake Razorpay /
 * Resend. Nothing leaves the process.
 * Run: npm run test:autoapply
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";

import { createAutoApplyRouter, createInboundHandler, handleAutoApplyWebhook, runAutoApplyRefunds } from "../routes/autoapply.js";
import { encryptSecret } from "../lib/autoapply/vault.js";
import { signInbound } from "../lib/autoapply/inbound.js";
import { learnedKey } from "../lib/autoapply/questions.js";
import { istMonthStart } from "../lib/autoapply/limits.js";
import { createFakeDb } from "./fixtures/fakeSupabase.mjs";

const PRO = "aaaaaaaa-0000-4000-8000-000000000001";
const FREE = "aaaaaaaa-0000-4000-8000-000000000002";
const CAPPED = "aaaaaaaa-0000-4000-8000-000000000003";
const NOCONSENT = "aaaaaaaa-0000-4000-8000-000000000004";
const USERS = { [PRO]: "pro", [FREE]: "free", [CAPPED]: "max", [NOCONSENT]: "pro" };
const VAULT_KEY = crypto.randomBytes(32).toString("base64");
const INBOUND_SECRET = "test-inbound-secret";

const mailDb = createFakeDb();
const pushes = [];
const db = createFakeDb({
  aa_profiles: [{ user_id: CAPPED, consent_at: new Date().toISOString(), onboarding_done: true }],
  aa_batches: [
    { user_id: CAPPED, pack_kind: "service", pack_size: 100, price_paise: 99900, credits_total: 960, status: "running", purchased_at: new Date().toISOString() },
    { user_id: CAPPED, pack_kind: "service", pack_size: 100, price_paise: 99900, credits_total: 500, status: "refunded", purchased_at: new Date(istMonthStart().getTime() - 86400000).toISOString() },
  ],
  aa_jobs: [
    { job_key: "wd:acme:1", ats: "workday", company: "Acme", company_key: "acme", company_kind: "product", title: "Senior Backend Engineer", location: "Bengaluru, India", tenant_host: "acme.wd3.myworkdayjobs.com", source: "linkedin", posted_at: new Date(Date.now() - 2 * 86400000).toISOString(), closed_at: null },
    { job_key: "gh:beta:2", ats: "greenhouse", company: "Beta", company_key: "beta", company_kind: "product", title: "Backend Engineer II", location: "Remote - India", tenant_host: "boards.greenhouse.io", source: "boards", posted_at: new Date(Date.now() - 1 * 86400000).toISOString(), closed_at: null },
    { job_key: "gh:beta:3", ats: "greenhouse", company: "Beta", company_key: "beta", company_kind: "product", title: "Data Scientist", location: "Bengaluru, India", tenant_host: "boards.greenhouse.io", source: "boards", posted_at: new Date().toISOString(), closed_at: null },
    { job_key: "gh:old:4", ats: "greenhouse", company: "Old", company_key: "old", company_kind: "product", title: "Backend Engineer", location: "Bengaluru", tenant_host: "boards.greenhouse.io", source: "boards", posted_at: new Date(Date.now() - 20 * 86400000).toISOString(), closed_at: null },
    { job_key: "gh:closed:5", ats: "greenhouse", company: "Closed", company_key: "closed", company_kind: "product", title: "Backend Engineer", location: "Bengaluru", tenant_host: "boards.greenhouse.io", source: "boards", posted_at: new Date().toISOString(), closed_at: new Date().toISOString() },
    { job_key: "wd:infy:6", ats: "workday", company: "Infy", company_key: "infy", company_kind: "service", title: "Backend Engineer", location: "Pune", tenant_host: "infy.wd3.myworkdayjobs.com", source: "boards", posted_at: new Date().toISOString(), closed_at: null },
  ],
});

const orders = new Map();
const refunds = [];
const razorpay = {
  isEnabled: () => true,
  keyId: () => "rzp_test_key",
  async createOrder({ amountPaise, currency, notes }) {
    const o = { id: `order_${crypto.randomBytes(6).toString("hex")}`, amount: amountPaise, currency, notes, status: "created" };
    orders.set(o.id, o);
    return o;
  },
  async fetchOrder(id) {
    return orders.get(id) || null;
  },
  verifyPaymentSignature: ({ orderId, paymentId, signature }) => signature === `sig:${orderId}|${paymentId}`,
  async listRefunds(paymentId) {
    return refunds.filter((r) => r.payment_id === paymentId);
  },
  async refundPayment(paymentId, { amountPaise, notes }) {
    const r = { id: `rfnd_${refunds.length + 1}`, payment_id: paymentId, amount: amountPaise, notes };
    refunds.push(r);
    return r;
  },
};

const sent = [];
const resend = { async sendEmail(m) { sent.push(m); return { id: "re_1" }; } };

let server;
let base;
before(async () => {
  const app = express();
  app.post("/api/inbound/email", express.raw({ type: () => true }), createInboundHandler({ db, mailDb, getSecret: () => INBOUND_SECRET, sendPush: async (a) => { pushes.push(a); return { sent: 1, removed: 0 }; }, onAfter: (p) => (lastAfter = p) }));
  app.use(express.json());
  app.use(
    "/api/autoapply",
    createAutoApplyRouter({
      db,
      mailDb,
      env: { VAPID_PUBLIC_KEY: "BPUBLICKEY", VAPID_PRIVATE_KEY: "x" },
      razorpay,
      getUserPlan: async (uid) => USERS[uid] || "free",
      authenticate: (req, res, next) => {
        const uid = String(req.headers.authorization || "").replace(/^Bearer /, "");
        if (!USERS[uid]) return res.status(401).json({ error: { code: "auth_required", message: "x" } });
        req.user = { id: uid, email: `${uid.slice(-4)}@mail.test` };
        // a JWT-shaped token: fresh iat, last sign-in (amr) X-Test-Token-Age seconds ago (default: just now)
        const age = Number(req.headers["x-test-token-age"] || 0);
        const nowS = Math.floor(Date.now() / 1000);
        const amr = req.headers["x-test-no-amr"] ? undefined : [{ method: "password", timestamp: nowS - age }];
        const claims = Buffer.from(JSON.stringify({ sub: uid, iat: nowS, amr })).toString("base64url");
        req.authToken = `h.${claims}.s`;
        next();
      },
      vaultKey: VAULT_KEY,
      extractText: async () => "Priya Sharma\npriya@example.com | +91 98765 43210\nSkills\nGo, Kafka",
    }),
  );
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());
let lastAfter = null;

async function call(method, path, { user = PRO, body, headers = {}, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(user ? { Authorization: `Bearer ${user}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}

test("auth required with contract error shape", async () => {
  const r = await call("GET", "/api/autoapply/me", { user: null });
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, "auth_required");
});

test("GET /me for free and pro users", async () => {
  const free = await call("GET", "/api/autoapply/me", { user: FREE });
  assert.equal(free.status, 200);
  assert.equal(free.json.eligible, false);
  assert.equal(free.json.email.alias, null);
  const pro = await call("GET", "/api/autoapply/me");
  assert.equal(pro.json.eligible, true);
  assert.equal(pro.json.plan, "pro");
  assert.equal(pro.json.usage.monthly_cap, 1000);
  assert.equal(pro.json.config.packs.service[50], 59900);
});

let alias;
test("PUT /profile creates a unique alias once, validates input", async () => {
  const r = await call("PUT", "/api/autoapply/profile", { body: { profile: { first_name: "Débo Priyo", last_name: "X" }, prefs: { titles: ["backend engineer"], locations: ["bengaluru", "remote"] }, consent: true, contact_email: "real@gmail.com" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  alias = r.json.profile.apply_alias;
  assert.match(alias, /^deboprivo\.[a-z0-9]{4}$|^debopriyo\.[a-z0-9]{4}$/);
  assert.ok(r.json.profile.consent_at);
  const again = await call("PUT", "/api/autoapply/profile", { body: { review_before_apply: false, onboarding_done: true } });
  assert.equal(again.json.profile.apply_alias, alias);
  assert.equal(again.json.profile.review_before_apply, false);
  const me = await call("GET", "/api/autoapply/me");
  assert.equal(me.json.email.address, `${alias}@apply.vloombox.in`);
  assert.equal(me.json.onboarding_done, true);
  const badMode = await call("PUT", "/api/autoapply/profile", { body: { email_mode: "pigeon" } });
  assert.equal(badMode.status, 400);
  assert.equal(badMode.json.error.code, "invalid_input");
});

test("answers GET/PUT", async () => {
  const g = await call("GET", "/api/autoapply/answers");
  assert.ok(g.json.questions.length > 20);
  const p = await call("PUT", "/api/autoapply/answers", { body: { answers: { "fields.city": "Bengaluru", "facts.notice_period_days": 30, "facts.needs_sponsorship": "No" } } });
  assert.equal(p.status, 200);
  assert.deepEqual(p.json.answers, { "fields.city": "Bengaluru", "facts.notice_period_days": "30", "facts.needs_sponsorship": "no" });
  const del = await call("PUT", "/api/autoapply/answers", { body: { answers: { "fields.city": "" } } });
  assert.equal(del.json.answers["fields.city"], undefined);
  const bad = await call("PUT", "/api/autoapply/answers", { body: { answers: { "facts.notice_period_days": "soon" } } });
  assert.equal(bad.status, 400);
});

test("resume upload: type/size checks, storage path, parsed draft", async () => {
  const fd = new FormData();
  fd.append("resume", new Blob([Buffer.from("%PDF-1.4 fake")], { type: "application/pdf" }), "cv.pdf");
  const res = await fetch(base + "/api/autoapply/resume", { method: "POST", headers: { Authorization: `Bearer ${PRO}` }, body: fd });
  const j = await res.json();
  assert.equal(res.status, 200, JSON.stringify(j));
  assert.equal(j.resume_path, `${PRO}/resume.pdf`);
  assert.equal(j.parsed.first_name, "Priya");
  assert.ok(db.storage.calls.find((c) => c.op === "upload" && c.bucket === "aa-resumes" && c.path === `${PRO}/resume.pdf`));
  const fd2 = new FormData();
  fd2.append("resume", new Blob(["hello"], { type: "text/plain" }), "cv.txt");
  const r2 = await fetch(base + "/api/autoapply/resume", { method: "POST", headers: { Authorization: `Bearer ${PRO}` }, body: fd2 });
  assert.equal(r2.status, 400);
  assert.equal((await r2.json()).error.code, "invalid_file");
  const fd3 = new FormData();
  fd3.append("resume", new Blob([Buffer.alloc(5 * 1024 * 1024 + 10, 0x25)], { type: "application/pdf" }), "big.pdf");
  const r3 = await fetch(base + "/api/autoapply/resume", { method: "POST", headers: { Authorization: `Bearer ${PRO}` }, body: fd3 });
  assert.equal(r3.status, 413);
});

test("GET /supply matches kind, window, prefs", async () => {
  const r = await call("GET", "/api/autoapply/supply?kind=product&window_days=7");
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 2); // Acme + Beta backend (not data scientist, not 20d old, not closed)
  assert.deepEqual(r.json.by_ats, { workday: 1, greenhouse: 1 });
  assert.equal(r.json.sample[0].company, "Beta");
  assert.deepEqual(Object.keys(r.json.sample[0]).sort(), ["company", "location", "posted_at", "title"]);
  const wide = await call("GET", "/api/autoapply/supply?kind=product&window_days=30");
  assert.equal(wide.json.count, 3);
  const bad = await call("GET", "/api/autoapply/supply?kind=product&window_days=31");
  assert.equal(bad.status, 400);
});

let batchId;
let orderId;
test("POST /orders: eligibility, cap, success", async () => {
  const free = await call("POST", "/api/autoapply/orders", { user: FREE, body: { pack_kind: "service", pack_size: 50, window_days: 7 } });
  assert.equal(free.status, 403);
  assert.equal(free.json.error.code, "not_eligible");
  const capped = await call("POST", "/api/autoapply/orders", { user: CAPPED, body: { pack_kind: "service", pack_size: 50 } });
  assert.equal(capped.status, 409);
  assert.equal(capped.json.error.code, "monthly_cap");
  const bad = await call("POST", "/api/autoapply/orders", { body: { pack_kind: "service", pack_size: 60 } });
  assert.equal(bad.status, 400);
  const removed = await call("POST", "/api/autoapply/orders", { body: { pack_kind: "service", pack_size: 80 } });
  assert.equal(removed.status, 400, "80 packs are no longer sold");
  const ok = await call("POST", "/api/autoapply/orders", { body: { pack_kind: "service", pack_size: 50, window_days: 7 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.amount, 59900);
  assert.equal(ok.json.currency, "INR");
  assert.equal(ok.json.key_id, "rzp_test_key");
  batchId = ok.json.batch_id;
  orderId = ok.json.order_id;
  assert.deepEqual(orders.get(orderId).notes, { kind: "autoapply", batch_id: batchId, user_id: PRO });
  const b = db.rows("aa_batches").find((x) => x.id === batchId);
  assert.equal(b.status, "pending_payment");
  assert.equal(b.razorpay_order_id, orderId);
  const list = await call("GET", "/api/autoapply/batches");
  assert.ok(!list.json.batches.find((x) => x.id === batchId), "pending_payment hidden from list");
});

test("POST /orders/verify: signature, idempotent paid + single purchase ledger row; webhook replay", async () => {
  const bad = await call("POST", "/api/autoapply/orders/verify", { body: { razorpay_order_id: orderId, razorpay_payment_id: "pay_1", razorpay_signature: "nope" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "signature_mismatch");
  const body = { razorpay_order_id: orderId, razorpay_payment_id: "pay_1", razorpay_signature: `sig:${orderId}|pay_1` };
  const ok = await call("POST", "/api/autoapply/orders/verify", { body });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.batch.status, "paid");
  assert.ok(ok.json.batch.purchased_at);
  const days = (Date.parse(ok.json.batch.expires_at) - Date.parse(ok.json.batch.purchased_at)) / 86400000;
  assert.equal(days, 90);
  const again = await call("POST", "/api/autoapply/orders/verify", { body });
  assert.equal(again.status, 200);
  const wh = await handleAutoApplyWebhook({ db, body: { event: "payment.captured", payload: { payment: { entity: { id: "pay_1", order_id: orderId, amount: 59900, notes: { kind: "autoapply" } } } } } });
  assert.equal(wh.autoapply, true);
  const ledger = db.rows("aa_credit_ledger").filter((l) => l.batch_id === batchId);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].delta, 50);
  assert.equal(ledger[0].reason, "purchase");
  const other = await call("POST", "/api/autoapply/orders/verify", { user: CAPPED, body });
  assert.equal(other.status, 404, "another user cannot claim this order");
  const me = await call("GET", "/api/autoapply/me");
  assert.equal(me.json.usage.month_purchased, 50);
});

test("webhook alone marks a pending batch paid (lost browser callback); non-AutoApply events pass through", async () => {
  const o = await call("POST", "/api/autoapply/orders", { body: { pack_kind: "product", pack_size: 100, window_days: 30 } });
  const wrongAmt = await handleAutoApplyWebhook({ db, body: { event: "payment.captured", payload: { payment: { entity: { id: "pay_2", order_id: o.json.order_id, amount: 100 } } } } });
  assert.match(wrongAmt.note, /amount mismatch/);
  const r = await handleAutoApplyWebhook({ db, body: { event: "payment.captured", payload: { payment: { entity: { id: "pay_2", order_id: o.json.order_id, amount: 149900 } } } } });
  assert.equal(r.status, "paid");
  assert.equal(db.rows("aa_credit_ledger").filter((l) => l.batch_id === o.json.batch_id).length, 1);
  assert.equal(await handleAutoApplyWebhook({ db, body: { event: "payment.captured", payload: { payment: { entity: { id: "p", order_id: "order_plan" } } } } }), null);
  assert.equal(await handleAutoApplyWebhook({ db, body: { event: "subscription.charged" } }), null);
});

function seedTasks(bId, statuses) {
  return statuses.map((status, i) => {
    const row = { id: crypto.randomUUID(), batch_id: bId, user_id: PRO, job_key: `k:${bId}:${i}`, company: `Co${i}`, company_key: `co${i}`, title: "Backend Engineer", ats: "greenhouse", tenant_host: "boards.greenhouse.io", status, score: i };
    db.rows("aa_tasks").push(row);
    return row;
  });
}

test("batch review: remove task, approve queues shortlisted", async () => {
  const b = db.rows("aa_batches").find((x) => x.id === batchId);
  b.status = "running";
  const [t0, t1] = seedTasks(batchId, ["shortlisted", "shortlisted", "applied"]);
  const notReview = await call("POST", `/api/autoapply/batches/${batchId}/tasks/${t0.id}/remove`);
  assert.equal(notReview.status, 409);
  b.status = "review";
  b.review_until = new Date(Date.now() + 3600e3).toISOString();
  const rm = await call("POST", `/api/autoapply/batches/${batchId}/tasks/${t0.id}/remove`);
  assert.equal(rm.status, 200);
  assert.equal(rm.json.task.status, "removed");
  const detail = await call("GET", `/api/autoapply/batches/${batchId}`);
  assert.deepEqual(detail.json.counts, { removed: 1, shortlisted: 1, applied: 1 });
  assert.equal(detail.json.tasks.length, 3);
  const foreign = await call("GET", `/api/autoapply/batches/${batchId}`, { user: FREE });
  assert.equal(foreign.status, 404);
  const ap = await call("POST", `/api/autoapply/batches/${batchId}/approve`);
  assert.equal(ap.status, 200);
  assert.equal(ap.json.batch.status, "running");
  assert.equal(db.rows("aa_tasks").find((t) => t.id === t1.id).status, "queued");
  assert.equal(db.rows("aa_tasks").find((t) => t.id === t0.id).status, "removed");
});

test("pause / resume / cancel -> refund_due -> refunds cron -> refunded", async () => {
  const p = await call("POST", `/api/autoapply/batches/${batchId}/pause`);
  assert.equal(p.json.batch.status, "paused");
  const p2 = await call("POST", `/api/autoapply/batches/${batchId}/pause`);
  assert.equal(p2.status, 409);
  const r = await call("POST", `/api/autoapply/batches/${batchId}/resume`);
  assert.equal(r.json.batch.status, "running");
  const b = db.rows("aa_batches").find((x) => x.id === batchId);
  b.credits_used = 20;
  const [inflight] = seedTasks(batchId, ["running", "needs_you"]);
  const ny = { id: crypto.randomUUID(), task_id: db.rows("aa_tasks").at(-1).id, user_id: PRO, kind: "captcha", payload: {} };
  db.rows("aa_needs_you").push({ ...ny, resolved_at: null, created_at: new Date().toISOString() });
  const c = await call("POST", `/api/autoapply/batches/${batchId}/cancel`);
  assert.equal(c.json.batch.status, "refund_due");
  const tasks = db.rows("aa_tasks").filter((t) => t.batch_id === batchId);
  assert.ok(!tasks.some((t) => ["shortlisted", "queued"].includes(t.status)));
  assert.equal(db.rows("aa_needs_you").find((n) => n.id === ny.id).resolution, "expired");

  let out = await runAutoApplyRefunds({ db, razorpay });
  assert.equal(out.results.find((x) => x.batch_id === batchId).skipped, "in_flight");
  inflight.status = "applied";
  out = await runAutoApplyRefunds({ db, razorpay });
  const res = out.results.find((x) => x.batch_id === batchId);
  assert.equal(res.refunded_paise, 35940); // 59900 * 30 / 50
  assert.equal(b.status, "refunded");
  assert.equal(b.refund_paise, 35940);
  assert.equal(b.razorpay_refund_id, "rfnd_1");
  const led = db.rows("aa_credit_ledger").filter((l) => l.batch_id === batchId && l.reason === "refund");
  assert.deepEqual(led.map((l) => l.delta), [-30]);
  // crash-safety: batch flipped back to refund_due after Razorpay refunded -> reuse, no 2nd refund
  b.status = "refund_due";
  await runAutoApplyRefunds({ db, razorpay });
  assert.equal(refunds.length, 1);
  assert.equal(db.rows("aa_credit_ledger").filter((l) => l.batch_id === batchId && l.reason === "refund").length, 1);
});

test("needs-you: list, answer -> aa_answers + task queued; done; double resolve", async () => {
  const b2 = db.rows("aa_batches").find((x) => x.user_id === PRO && x.pack_kind === "product");
  const [ta, tb] = seedTasks(b2.id, ["needs_you", "needs_you"]);
  const label = "Are you willing to work from our Pune office?";
  const n1 = { id: crypto.randomUUID(), task_id: ta.id, user_id: PRO, kind: "question", payload: { question: label, options: ["Yes", "No"] }, resolved_at: null, created_at: new Date().toISOString() };
  const n2 = { id: crypto.randomUUID(), task_id: tb.id, user_id: PRO, kind: "captcha", payload: { apply_url: "https://x" }, resolved_at: null, created_at: new Date().toISOString() };
  db.rows("aa_needs_you").push(n1, n2);
  const list = await call("GET", "/api/autoapply/needs-you");
  const item = list.json.items.find((i) => i.id === n1.id);
  assert.equal(item.task.company, ta.company);
  const a = await call("POST", `/api/autoapply/needs-you/${n1.id}`, { body: { action: "answer", answer: "Yes" } });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.item.resolution, "answered");
  const key = learnedKey(label);
  assert.equal(a.json.item.answer_key, key);
  assert.equal(db.rows("aa_answers").find((r) => r.user_id === PRO && r.question_key === key).answer, "Yes");
  assert.equal(ta.status, "queued");
  // a retry of the same action is idempotent (200, the stored item); another action on it is a conflict
  const again = await call("POST", `/api/autoapply/needs-you/${n1.id}`, { body: { action: "answer", answer: "Yes" } });
  assert.equal(again.status, 200);
  assert.equal(again.json.item.resolution, "answered");
  const other = await call("POST", `/api/autoapply/needs-you/${n1.id}`, { body: { action: "dismiss" } });
  assert.equal(other.status, 409);
  assert.equal(other.json.error.code, "already_resolved");
  const d = await call("POST", `/api/autoapply/needs-you/${n2.id}`, { body: { action: "done" } });
  assert.equal(d.json.item.resolution, "done_by_user");
  assert.equal(tb.status, "skipped");
  assert.equal(tb.reason_code, "done_by_user");
  const after = await call("GET", "/api/autoapply/needs-you");
  assert.ok(!after.json.items.find((i) => i.id === n1.id || i.id === n2.id));
});

test("needs-you: profile item (no task) is listed; only dismiss; pause / cancel from waiting_profile close it", async () => {
  const mk = (status) => {
    const b = { id: crypto.randomUUID(), user_id: PRO, pack_kind: "product", pack_size: 50, price_paise: 59900, credits_total: 50, credits_used: 0, status, purchased_at: new Date().toISOString(), waiting_detail: { reason: "profile_incomplete", missing: [{ key: "resume", label: "Upload your resume" }] } };
    db.rows("aa_batches").push(b);
    return b;
  };
  const b1 = mk("waiting_profile");
  const b2 = mk("waiting_profile");
  const tasksBefore = JSON.stringify(db.rows("aa_tasks"));
  const ny = { id: crypto.randomUUID(), task_id: null, batch_id: b1.id, user_id: PRO, kind: "profile", payload: { missing: [{ key: "resume", label: "Upload your resume" }], batch_id: b1.id, url: "/autoapply/profile" }, resolved_at: null, created_at: new Date().toISOString() };
  db.rows("aa_needs_you").push(ny);

  const list = await call("GET", "/api/autoapply/needs-you");
  assert.equal(list.status, 200);
  const item = list.json.items.find((i) => i.id === ny.id);
  assert.ok(item, "profile item is listed without a task");
  assert.equal(item.kind, "profile");
  assert.equal(item.task, null);
  assert.equal(item.task_id, null);
  assert.equal(item.batch_id, b1.id);
  assert.deepEqual(item.payload.missing, [{ key: "resume", label: "Upload your resume" }]);

  for (const action of ["done", "answer"]) {
    const r = await call("POST", `/api/autoapply/needs-you/${ny.id}`, { body: { action, answer: "x" } });
    assert.equal(r.status, 409, action);
    assert.equal(r.json.error.code, "invalid_action");
  }
  assert.equal(db.rows("aa_needs_you").find((n) => n.id === ny.id).resolved_at, null);

  const me = await call("GET", "/api/autoapply/me");
  assert.equal(me.json.profile_check.ok, false);
  assert.ok(me.json.profile_check.missing.every((m) => m.key && m.label));

  // pause one waiting batch: another still waits -> item stays open
  const p = await call("POST", `/api/autoapply/batches/${b1.id}/pause`);
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(p.json.batch.status, "paused");
  assert.equal(db.rows("aa_needs_you").find((n) => n.id === ny.id).resolved_at, null);
  // cancel the last waiting batch: unused credits -> refund_due and the profile item closes
  const c = await call("POST", `/api/autoapply/batches/${b2.id}/cancel`);
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.batch.status, "refund_due");
  const closed = db.rows("aa_needs_you").find((n) => n.id === ny.id);
  assert.ok(closed.resolved_at);
  assert.equal(closed.resolution, "dismissed");
  assert.equal(JSON.stringify(db.rows("aa_tasks")), tasksBefore, "no task touched");

  // dismiss is allowed and never touches a task
  const ny2 = { ...ny, id: crypto.randomUUID(), resolved_at: null, resolution: null };
  db.rows("aa_needs_you").push(ny2);
  const d = await call("POST", `/api/autoapply/needs-you/${ny2.id}`, { body: { action: "dismiss" } });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.equal(d.json.item.resolution, "dismissed");
  assert.equal(JSON.stringify(db.rows("aa_tasks")), tasksBefore);
  // clean up so later tests see no extra batches
  for (const b of [b1, b2]) b.status = "refunded";
});

test("accounts list + reveal (vault) + rate limit 10/hour", async () => {
  db.rows("aa_portal_accounts").push({ user_id: PRO, tenant_host: "acme.wd3.myworkdayjobs.com", login_email: `${alias}.acme@apply.vloombox.in`, secret_ciphertext: encryptSecret("Pw!12345", PRO, "acme.wd3.myworkdayjobs.com", { key: VAULT_KEY }), status: "active", created_at: new Date().toISOString() });
  const l = await call("GET", "/api/autoapply/accounts");
  assert.equal(l.json.accounts.length, 1);
  assert.ok(!("secret_ciphertext" in l.json.accounts[0]));
  const stale = await call("POST", "/api/autoapply/accounts/reveal", { body: { tenant_host: "acme.wd3.myworkdayjobs.com" }, headers: { "X-Test-Token-Age": "900" } });
  assert.equal(stale.status, 401, "a sign-in older than 10 min needs a fresh one, even with a just-refreshed token");
  assert.equal(stale.json.error.code, "reauth_required");
  const noAmr = await call("POST", "/api/autoapply/accounts/reveal", { body: { tenant_host: "acme.wd3.myworkdayjobs.com" }, headers: { "X-Test-No-Amr": "1" } });
  assert.equal(noAmr.status, 401, "a token without amr cannot prove a recent sign-in");
  assert.equal(noAmr.json.error.code, "reauth_required");
  const r = await call("POST", "/api/autoapply/accounts/reveal", { body: { tenant_host: "acme.wd3.myworkdayjobs.com" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.password, "Pw!12345");
  const nf = await call("POST", "/api/autoapply/accounts/reveal", { body: { tenant_host: "nope.example.com" } });
  assert.equal(nf.status, 404);
  let last;
  for (let i = 0; i < 7; i++) last = await call("POST", "/api/autoapply/accounts/reveal", { body: { tenant_host: "acme.wd3.myworkdayjobs.com" } });
  assert.equal(last.status, 429);
  assert.equal(last.json.error.code, "rate_limited");
});

function signed(body, ts = Math.floor(Date.now() / 1000)) {
  const raw = Buffer.from(JSON.stringify(body));
  return { raw, headers: { "Content-Type": "application/json", "X-AA-Timestamp": String(ts), "X-AA-Signature": signInbound(INBOUND_SECRET, String(ts), raw) } };
}

test("inbound email: HMAC, alias -> user, mail db row with category, never forwarded, push only for important", async () => {
  const mail = { to: `${alias}.acme@apply.vloombox.in`, from: "no-reply@myworkday.com", from_name: "Acme Careers", subject: "Verify your account", received_at: new Date().toISOString(), codes: ["482913"], links: ["https://acme.wd3.myworkdayjobs.com/verify"], is_human: false, text_excerpt: "code 482913", raw_key: "mail/x.eml", reply_to: null, message_id: "<m1>", auth: { spf: "pass", dkim: "pass", dmarc: "pass", dkim_domains: ["myworkday.com"] } };
  const s = signed(mail);
  const r = await call("POST", "/api/inbound/email", { user: null, raw: s.raw, headers: s.headers });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(db.rows("aa_mail_events").length, 0, "mail never lands in the main db when a separate mail db is configured");
  const ev = mailDb.rows("aa_mail_events").at(-1);
  assert.equal(ev.user_id, PRO);
  assert.equal(ev.alias, `${alias}.acme`);
  assert.deepEqual(ev.codes, ["482913"]);
  assert.equal(ev.category, "code");
  assert.equal(ev.has_attachments, false);
  assert.equal(ev.auth_ok, true);
  assert.ok(Math.abs(Date.parse(ev.expires_at) - Date.now() - 7 * 86400000) < 60000, "code mail expires 7 days after arrival");
  assert.equal(ev.company, "Acme");
  assert.equal(ev.read_at, null);
  assert.deepEqual(mailDb.rpcCalls.at(-1), { name: "aa_notify_mail", args: { p_user: PRO, p_event: ev.id } });
  assert.equal(db.rpcCalls.filter((c) => c.name === "aa_notify_mail").length, 0);
  await lastAfter;
  assert.equal(pushes.length, 0, "a code mail does not push");
  assert.equal(sent.length, 0, "nothing is ever sent through Resend for inbound mail");

  const human = signed({ ...mail, from: "jane@acme.com", from_name: "Jane at Acme", subject: "Interview", is_human: true, codes: [], has_attachments: true, message_id: "<m2>" });
  await call("POST", "/api/inbound/email", { user: null, raw: human.raw, headers: human.headers });
  await lastAfter;
  assert.equal(sent.length, 0, "recruiter mail is not forwarded");
  const hev = mailDb.rows("aa_mail_events").at(-1);
  assert.equal(hev.category, "important");
  assert.equal(hev.has_attachments, true);
  assert.equal(hev.forwarded_at ?? null, null);
  assert.equal(hev.expires_at, null);
  assert.equal(hev.kind, "interview");
  assert.equal(hev.company, "Acme");
  assert.equal(mailDb.rows("aa_interviews").filter((r) => r.mail_event_id === hev.id).length, 1, "an interview record is made");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].userId, PRO);
  assert.equal(pushes[0].event.id, hev.id);

  const unknown = signed({ ...mail, to: "ghost.zzzz@apply.vloombox.in" });
  await call("POST", "/api/inbound/email", { user: null, raw: unknown.raw, headers: unknown.headers });
  const uev = mailDb.rows("aa_mail_events").at(-1);
  assert.equal(uev.user_id, null);
  assert.ok(Math.abs(Date.parse(uev.expires_at) - Date.now() - 3 * 86400000) < 60000, "unknown-alias mail expires after 3 days");

  // spoofed / unauthenticated OTP mail: stored without codes or links, never 'code', no worker wake-up
  const notifies = mailDb.rpcCalls.length;
  const { auth: _a, ...noAuth } = mail;
  const spoof = signed({ ...noAuth, message_id: "<spoof1>" });
  assert.equal((await call("POST", "/api/inbound/email", { user: null, raw: spoof.raw, headers: spoof.headers })).status, 200);
  const sev = mailDb.rows("aa_mail_events").at(-1);
  assert.equal(sev.auth_ok, false);
  assert.deepEqual(sev.codes, []);
  assert.deepEqual(sev.links, []);
  assert.notEqual(sev.category, "code");
  assert.equal(mailDb.rpcCalls.length, notifies, "no aa_notify_mail for unauthenticated mail");
  const failed = signed({ ...mail, message_id: "<spoof2>", auth: { spf: "pass", dkim: "pass", dmarc: "fail", dkim_domains: ["evil.test"] } });
  await call("POST", "/api/inbound/email", { user: null, raw: failed.raw, headers: failed.headers });
  assert.equal(mailDb.rows("aa_mail_events").at(-1).auth_ok, false, "DMARC fail is unauthenticated even with SPF pass");

  const stale = signed(mail, Math.floor(Date.now() / 1000) - 120);
  assert.equal((await call("POST", "/api/inbound/email", { user: null, raw: stale.raw, headers: stale.headers })).status, 401);
  const tampered = signed(mail);
  assert.equal((await call("POST", "/api/inbound/email", { user: null, raw: Buffer.from(JSON.stringify({ ...mail, to: "x" })), headers: tampered.headers })).status, 401);
});

test("inbox: tabs, search, pagination, detail, ownership", async () => {
  const day = 86400000;
  const base = Date.now();
  const extra = [
    { category: "other", subject: "Newsletter from Globex", sender: "news@globex.com" },
    { category: "received", subject: "Thank you for applying", sender: "careers@initech.com" },
  ];
  extra.forEach((m, i) => {
    mailDb.rows("aa_mail_events").push({ id: 900 + i, user_id: PRO, alias, codes: [], links: [], is_human: false, text_excerpt: "x", received_at: new Date(base - (i + 1) * day).toISOString(), has_attachments: false, expires_at: new Date(base + day).toISOString(), ...m });
  });
  mailDb.rows("aa_mail_events").push({ id: 950, user_id: FREE, alias: "z.z", sender: "other@user.com", subject: "Someone else", codes: [], links: [], is_human: false, text_excerpt: "", category: "important", received_at: new Date().toISOString(), expires_at: new Date(base + day).toISOString() });

  const all = await call("GET", "/api/autoapply/inbox");
  assert.equal(all.status, 200);
  assert.ok(all.json.mails.length >= 4);
  assert.ok(all.json.mails.every((m) => m.id !== 950), "never shows another user's mail");
  assert.deepEqual(Object.keys(all.json.mails[0]).sort(), ["category", "codes", "company", "expires_at", "from_name", "has_attachments", "id", "is_human", "kind", "read_at", "received_at", "sender", "subject", "text_excerpt"]);
  const imp = await call("GET", "/api/autoapply/inbox?tab=important");
  assert.ok(imp.json.mails.length >= 1 && imp.json.mails.every((m) => m.category === "important"));
  const codes = await call("GET", "/api/autoapply/inbox?tab=codes");
  assert.ok(codes.json.mails.length >= 1 && codes.json.mails.every((m) => m.category === "code"));
  assert.equal((await call("GET", "/api/autoapply/inbox?tab=bogus")).status, 400);

  const found = await call("GET", "/api/autoapply/inbox?q=globex");
  assert.deepEqual(found.json.mails.map((m) => m.id), [900]);
  assert.equal((await call("GET", "/api/autoapply/inbox?q=" + encodeURIComponent("zz,(nothing)"))).json.mails.length, 0);

  const page1 = await call("GET", "/api/autoapply/inbox?limit=2");
  assert.equal(page1.json.mails.length, 2);
  assert.ok(page1.json.next_before);
  const page2 = await call("GET", "/api/autoapply/inbox?limit=2&before=" + encodeURIComponent(page1.json.next_before));
  assert.ok(page2.json.mails.length >= 1);
  assert.ok(page2.json.mails.every((m) => m.received_at < page1.json.next_before));
  assert.equal((await call("GET", "/api/autoapply/inbox?before=nope")).status, 400);

  const one = await call("GET", "/api/autoapply/inbox/900");
  assert.equal(one.status, 200);
  assert.equal(one.json.mail.subject, "Newsletter from Globex");
  assert.ok(Array.isArray(one.json.mail.links));
  assert.equal((await call("GET", "/api/autoapply/inbox/950")).status, 404);
  assert.equal((await call("GET", "/api/autoapply/inbox/abc")).status, 404);
});

test("inbound email: rejection pushes and expires in 30 days; receipts do not push; .ics interview is extracted", async () => {
  const base = { to: `${alias}@apply.vloombox.in`, from: "no-reply@globex.com", from_name: "Globex Careers", received_at: new Date().toISOString(), codes: [], links: [], is_human: false, raw_key: null, reply_to: null, message_id: null };
  const before = pushes.length;

  const rej = signed({ ...base, subject: "Update on your application", text_excerpt: "Unfortunately, we will not be moving forward with your application." });
  await call("POST", "/api/inbound/email", { user: null, raw: rej.raw, headers: rej.headers });
  await lastAfter;
  const rev = mailDb.rows("aa_mail_events").at(-1);
  assert.equal(rev.category, "rejected");
  assert.equal(rev.kind, "rejection");
  assert.ok(Math.abs(Date.parse(rev.expires_at) - Date.now() - 30 * 86400000) < 60000, "rejection expires 30 days after receipt");
  assert.equal(pushes.length, before + 1, "a rejection pushes");

  const rcv = signed({ ...base, subject: "Thank you for applying", text_excerpt: "We have received your application." });
  await call("POST", "/api/inbound/email", { user: null, raw: rcv.raw, headers: rcv.headers });
  const cev = mailDb.rows("aa_mail_events").at(-1);
  assert.equal(cev.category, "received");
  assert.ok(Math.abs(Date.parse(cev.expires_at) - Date.now() - 30 * 86400000) < 60000);
  assert.equal(pushes.length, before + 1, "a receipt does not push");

  const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "DTSTART:20991201T083000Z", "DTEND:20991201T091500Z", "SUMMARY:Interview: Data Engineer - Globex", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const inv = signed({ ...base, subject: "Invitation: Globex interview", text_excerpt: "See invite", ics, meeting_links: ["https://meet.google.com/abc-defg-hij"] });
  await call("POST", "/api/inbound/email", { user: null, raw: inv.raw, headers: inv.headers });
  await lastAfter;
  const iev = mailDb.rows("aa_mail_events").at(-1);
  assert.equal(iev.kind, "interview");
  assert.equal(iev.expires_at, null);
  assert.equal("ics" in iev, false, "the .ics text is not stored on the mail row");
  const iv = mailDb.rows("aa_interviews").find((r) => r.mail_event_id === iev.id);
  assert.equal(iv.user_id, PRO);
  assert.equal(iv.starts_at, "2099-12-01T08:30:00.000Z");
  assert.equal(iv.role, "Data Engineer");
  assert.equal(iv.meeting_provider, "google_meet");
  assert.equal(pushes.length, before + 2);
  assert.equal(pushes.at(-1).event.kind, "interview");
});

test("inbox: category / kind / company / unread filters, unread count, read on open, read-all, companies, interviews", async () => {
  const mine = () => mailDb.rows("aa_mail_events").filter((r) => r.user_id === PRO);
  const rej = await call("GET", "/api/autoapply/inbox?category=rejected");
  assert.equal(rej.status, 200);
  assert.ok(rej.json.mails.length >= 1 && rej.json.mails.every((m) => m.category === "rejected"));
  const ivs = await call("GET", "/api/autoapply/inbox?kind=interview");
  assert.ok(ivs.json.mails.length >= 1 && ivs.json.mails.every((m) => m.kind === "interview"));
  assert.equal((await call("GET", "/api/autoapply/inbox?category=nope")).status, 400);
  assert.equal((await call("GET", "/api/autoapply/inbox?kind=nope")).status, 400);
  const glx = await call("GET", "/api/autoapply/inbox?company=globex");
  assert.ok(glx.json.mails.length >= 3 && glx.json.mails.every((m) => /globex/i.test(m.company)));

  const unread = await call("GET", "/api/autoapply/inbox/unread");
  assert.equal(unread.status, 200);
  const expect = mine().filter((r) => ["important", "rejected"].includes(r.category) && !r.read_at).length;
  assert.equal(unread.json.count, expect);
  assert.ok(unread.json.by_kind.rejection >= 1);

  const target = mine().find((r) => r.category === "rejected" && !r.read_at);
  const open = await call("GET", `/api/autoapply/inbox/${target.id}`);
  assert.equal(open.status, 200);
  assert.ok(open.json.mail.read_at, "opening a mail marks it read");
  assert.equal((await call("GET", "/api/autoapply/inbox/unread")).json.count, expect - 1);
  const unreadList = await call("GET", "/api/autoapply/inbox?unread=1");
  assert.ok(unreadList.json.mails.length >= 1 && unreadList.json.mails.every((m) => m.read_at == null));
  assert.ok(unreadList.json.mails.every((m) => m.id !== target.id));

  const ivMail = mine().filter((r) => r.kind === "interview").at(-1);
  const withIv = await call("GET", `/api/autoapply/inbox/${ivMail.id}`);
  assert.equal(withIv.json.interview.mail_event_id, ivMail.id);

  const comps = await call("GET", "/api/autoapply/inbox/companies");
  assert.ok(comps.json.companies.includes("Globex"));
  assert.equal(new Set(comps.json.companies.map((c) => c.toLowerCase())).size, comps.json.companies.length, "deduplicated");

  const list = await call("GET", "/api/autoapply/interviews");
  assert.equal(list.status, 200);
  assert.ok(list.json.interviews.length >= 2);
  assert.ok(list.json.interviews.every((i) => i.mail && i.mail.id === i.mail_event_id));
  assert.ok(list.json.now);

  assert.equal((await call("POST", "/api/autoapply/inbox/read-all")).status, 200);
  assert.equal((await call("GET", "/api/autoapply/inbox/unread")).json.count, 0);
  // another user's interviews are never listed
  mailDb.rows("aa_interviews").push({ id: 9999, mail_event_id: 950, user_id: FREE, company: "X", created_at: new Date().toISOString() });
  assert.ok((await call("GET", "/api/autoapply/interviews")).json.interviews.every((i) => i.id !== 9999));
});

test("push: key, subscribe (validated, per-user), unsubscribe", async () => {
  const k = await call("GET", "/api/autoapply/push/key");
  assert.deepEqual(k.json, { enabled: true, key: "BPUBLICKEY" });
  const sub = { endpoint: "https://push.example.test/abc", keys: { p256dh: "p256", auth: "authsecret" } };
  assert.equal((await call("POST", "/api/autoapply/push/subscribe", { body: sub })).status, 200);
  assert.equal((await call("POST", "/api/autoapply/push/subscribe", { body: sub })).status, 200, "idempotent on endpoint");
  assert.equal(db.rows("aa_push_subscriptions").length, 1);
  assert.equal(db.rows("aa_push_subscriptions")[0].user_id, PRO);
  assert.equal((await call("POST", "/api/autoapply/push/subscribe", { body: { ...sub, endpoint: "http://insecure.test/x" } })).status, 400);
  assert.equal((await call("POST", "/api/autoapply/push/subscribe", { body: { endpoint: sub.endpoint, keys: {} } })).status, 400);
  assert.equal((await call("POST", "/api/autoapply/push/subscribe", { user: null, body: sub })).status, 401);
  // another user cannot remove it
  assert.equal((await call("POST", "/api/autoapply/push/unsubscribe", { user: CAPPED, body: { endpoint: sub.endpoint } })).status, 200);
  assert.equal(db.rows("aa_push_subscriptions").length, 1);
  assert.equal((await call("POST", "/api/autoapply/push/unsubscribe", { body: { endpoint: sub.endpoint } })).status, 200);
  assert.equal(db.rows("aa_push_subscriptions").length, 0);
});

test("alert_prefs: saved and returned by /me", async () => {
  assert.deepEqual((await call("GET", "/api/autoapply/me")).json.alert_prefs, { email: true, push: true });
  assert.equal((await call("PUT", "/api/autoapply/profile", { body: { alert_prefs: { push: false } } })).status, 200);
  assert.deepEqual((await call("GET", "/api/autoapply/me")).json.alert_prefs, { email: true, push: false });
  assert.equal((await call("PUT", "/api/autoapply/profile", { body: { alert_prefs: { email: "no" } } })).status, 400);
  await call("PUT", "/api/autoapply/profile", { body: { alert_prefs: { push: true } } });
});

test("unknown autoapply path -> JSON 404", async () => {
  const r = await call("GET", "/api/autoapply/nope");
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, "not_found");
});

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
const USERS = { [PRO]: "pro", [FREE]: "free", [CAPPED]: "max" };
const VAULT_KEY = crypto.randomBytes(32).toString("base64");
const INBOUND_SECRET = "test-inbound-secret";

const db = createFakeDb({
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
  app.post("/api/inbound/email", express.raw({ type: () => true }), createInboundHandler({ db, resend, getSecret: () => INBOUND_SECRET, onForward: (p) => (lastForward = p) }));
  app.use(express.json());
  app.use(
    "/api/autoapply",
    createAutoApplyRouter({
      db,
      razorpay,
      getUserPlan: async (uid) => USERS[uid] || "free",
      authenticate: (req, res, next) => {
        const uid = String(req.headers.authorization || "").replace(/^Bearer /, "");
        if (!USERS[uid]) return res.status(401).json({ error: { code: "auth_required", message: "x" } });
        req.user = { id: uid, email: `${uid.slice(-4)}@mail.test` };
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
let lastForward = null;

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
  const o = await call("POST", "/api/autoapply/orders", { body: { pack_kind: "product", pack_size: 80, window_days: 30 } });
  const wrongAmt = await handleAutoApplyWebhook({ db, body: { event: "payment.captured", payload: { payment: { entity: { id: "pay_2", order_id: o.json.order_id, amount: 100 } } } } });
  assert.match(wrongAmt.note, /amount mismatch/);
  const r = await handleAutoApplyWebhook({ db, body: { event: "payment.captured", payload: { payment: { entity: { id: "pay_2", order_id: o.json.order_id, amount: 119900 } } } } });
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
  const again = await call("POST", `/api/autoapply/needs-you/${n1.id}`, { body: { action: "answer", answer: "No" } });
  assert.equal(again.status, 409);
  const d = await call("POST", `/api/autoapply/needs-you/${n2.id}`, { body: { action: "done" } });
  assert.equal(d.json.item.resolution, "done_by_user");
  assert.equal(tb.status, "skipped");
  assert.equal(tb.reason_code, "done_by_user");
  const after = await call("GET", "/api/autoapply/needs-you");
  assert.ok(!after.json.items.find((i) => i.id === n1.id || i.id === n2.id));
});

test("accounts list + reveal (vault) + rate limit 10/hour", async () => {
  db.rows("aa_portal_accounts").push({ user_id: PRO, tenant_host: "acme.wd3.myworkdayjobs.com", login_email: `${alias}.acme@apply.vloombox.in`, secret_ciphertext: encryptSecret("Pw!12345", PRO, "acme.wd3.myworkdayjobs.com", { key: VAULT_KEY }), status: "active", created_at: new Date().toISOString() });
  const l = await call("GET", "/api/autoapply/accounts");
  assert.equal(l.json.accounts.length, 1);
  assert.ok(!("secret_ciphertext" in l.json.accounts[0]));
  const r = await call("POST", "/api/autoapply/accounts/reveal", { body: { tenant_host: "acme.wd3.myworkdayjobs.com" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.password, "Pw!12345");
  const nf = await call("POST", "/api/autoapply/accounts/reveal", { body: { tenant_host: "nope.example.com" } });
  assert.equal(nf.status, 404);
  let last;
  for (let i = 0; i < 9; i++) last = await call("POST", "/api/autoapply/accounts/reveal", { body: { tenant_host: "acme.wd3.myworkdayjobs.com" } });
  assert.equal(last.status, 429);
  assert.equal(last.json.error.code, "rate_limited");
});

function signed(body, ts = Math.floor(Date.now() / 1000)) {
  const raw = Buffer.from(JSON.stringify(body));
  return { raw, headers: { "Content-Type": "application/json", "X-AA-Timestamp": String(ts), "X-AA-Signature": signInbound(INBOUND_SECRET, String(ts), raw) } };
}

test("inbound email: HMAC, alias -> user, notify, forward human mail, inbox", async () => {
  const mail = { to: `${alias}.acme@apply.vloombox.in`, from: "no-reply@myworkday.com", from_name: "Acme Careers", subject: "Verify your account", received_at: new Date().toISOString(), codes: ["482913"], links: ["https://acme.wd3.myworkdayjobs.com/verify"], is_human: false, text_excerpt: "code 482913", raw_key: "mail/x.eml", reply_to: null, message_id: "<m1>" };
  const s = signed(mail);
  const r = await call("POST", "/api/inbound/email", { user: null, raw: s.raw, headers: s.headers });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  const ev = db.rows("aa_mail_events").at(-1);
  assert.equal(ev.user_id, PRO);
  assert.equal(ev.alias, `${alias}.acme`);
  assert.deepEqual(ev.codes, ["482913"]);
  assert.deepEqual(db.rpcCalls.at(-1), { name: "aa_notify_mail", args: { p_user: PRO, p_event: ev.id } });
  await lastForward;
  assert.equal(sent.length, 0, "machine mail is not forwarded");

  const human = signed({ ...mail, from: "jane@acme.com", from_name: "Jane at Acme", subject: "Interview", is_human: true, codes: [] });
  await call("POST", "/api/inbound/email", { user: null, raw: human.raw, headers: human.headers });
  await lastForward;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "real@gmail.com");
  assert.equal(sent[0].from, '"Jane at Acme via Vloombox" <relay@apply.vloombox.in>');
  assert.equal(sent[0].replyTo, "jane@acme.com");
  assert.ok(db.rows("aa_mail_events").at(-1).forwarded_at);

  const unknown = signed({ ...mail, to: "ghost.zzzz@apply.vloombox.in" });
  await call("POST", "/api/inbound/email", { user: null, raw: unknown.raw, headers: unknown.headers });
  assert.equal(db.rows("aa_mail_events").at(-1).user_id, null);

  const stale = signed(mail, Math.floor(Date.now() / 1000) - 120);
  assert.equal((await call("POST", "/api/inbound/email", { user: null, raw: stale.raw, headers: stale.headers })).status, 401);
  const tampered = signed(mail);
  assert.equal((await call("POST", "/api/inbound/email", { user: null, raw: Buffer.from(JSON.stringify({ ...mail, to: "x" })), headers: tampered.headers })).status, 401);

  const inbox = await call("GET", "/api/autoapply/inbox?limit=5");
  assert.equal(inbox.json.mails.length, 2);
  assert.deepEqual(Object.keys(inbox.json.mails[0]).sort(), ["codes", "id", "is_human", "received_at", "sender", "subject", "text_excerpt"]);
});

test("unknown autoapply path -> JSON 404", async () => {
  const r = await call("GET", "/api/autoapply/nope");
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, "not_found");
});

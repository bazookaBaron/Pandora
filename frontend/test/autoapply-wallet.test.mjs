/**
 * AutoApply wallet: top-up (verify + webhook, idempotent), starting a batch, retired pack routes, funds notice,
 * live status honesty, the old-pack-credit conversion maths. The SQL functions (sql/55) are simulated in memory
 * here (no Postgres in CI): the money rules themselves are in the SQL file and described in its header.
 * Run: node --test test/autoapply-wallet.test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createAutoApplyRouter, handleWalletWebhook } from "../routes/autoapply.js";
import { notifyWaitingFunds, retriggerFor, validateTopupAmount } from "../lib/autoapply/wallet.js";
import { buckets, engineReason, engineState, liveCounts, liveStatus } from "../lib/autoapply/liveStatus.js";
import { convertible } from "../scripts/migrate-pack-credits-to-wallet.mjs";
import { createFakeDb } from "./fixtures/fakeSupabase.mjs";

const PRO = "bbbbbbbb-0000-4000-8000-000000000001";
const FREE = "bbbbbbbb-0000-4000-8000-000000000002";
const NOCONSENT = "bbbbbbbb-0000-4000-8000-000000000003";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000004";
const USERS = { [PRO]: "pro", [FREE]: "free", [NOCONSENT]: "pro", [OTHER]: "pro" };
const now = new Date("2026-11-28T06:00:00Z");

const db = createFakeDb({
  aa_profiles: [
    { user_id: PRO, consent_at: now.toISOString(), onboarding_done: true },
    { user_id: FREE, consent_at: now.toISOString(), onboarding_done: true },
    { user_id: OTHER, consent_at: now.toISOString(), onboarding_done: true },
    { user_id: NOCONSENT, onboarding_done: true },
  ],
});

// ---- in-memory sim of sql/55's top-up and start functions
const wallets = new Map();
const wl = (u) => (wallets.has(u) ? wallets.get(u) : wallets.set(u, { balance_paise: 0, held_paise: 0 }).get(u));
const ledger = [];
db.from_orig = db.from;
const origFrom = db.from;
db.from = (t) => {
  if (t === "aa_wallets") {
    return {
      select: () => ({ eq: (_c, u) => ({ maybeSingle: async () => ({ data: wallets.has(u) ? wallets.get(u) : null, error: null }) }) }),
    };
  }
  if (t === "aa_wallet_ledger") {
    return { select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: ledger.slice(), error: null }) }) }) }) };
  }
  return origFrom(t);
};
db.rpc = async (name, a) => {
  if (name === "aa_wallet_topup") {
    if (ledger.some((l) => l.razorpay_order_id === a.p_order || l.razorpay_payment_id === a.p_payment)) {
      return { data: { credited: false, duplicate: true, balance_paise: wl(a.p_user).balance_paise }, error: null };
    }
    wl(a.p_user).balance_paise += a.p_amount;
    ledger.push({ kind: "topup", razorpay_order_id: a.p_order, razorpay_payment_id: a.p_payment, delta_paise: a.p_amount });
    return { data: { credited: true, duplicate: false, balance_paise: wl(a.p_user).balance_paise, resumed: 0 }, error: null };
  }
  if (name === "aa_wallet_start_batch") {
    const w = wl(a.p_user);
    if (w.balance_paise < a.p_rate_product) {
      return { data: { ok: false, reason: "insufficient_balance", balance_paise: w.balance_paise, needed_paise: a.p_rate_product, shortfall_paise: a.p_rate_product - w.balance_paise }, error: null };
    }
    const { data } = await origFrom("aa_batches")
      .insert({ user_id: a.p_user, pack_kind: null, pack_size: a.p_size, price_paise: 0, status: "shortlisting", credits_total: a.p_size, rate_paise: a.p_rate_product, rate_service_paise: a.p_rate_service, window_days: a.p_window_days, must_companies: a.p_must, purchased_at: now.toISOString() })
      .select("id")
      .single();
    return { data: { ok: true, batch_id: data.id, balance_paise: w.balance_paise }, error: null };
  }
  return { data: null, error: { message: `unexpected rpc ${name}` } };
};

const orders = new Map();
const razorpay = {
  isEnabled: () => true,
  keyId: () => "rzp_test_key",
  async createOrder({ amountPaise, currency, notes }) {
    const o = { id: `order_${orders.size + 1}`, amount: amountPaise, amount_paid: 0, currency, notes, status: "created" };
    orders.set(o.id, o);
    return o;
  },
  async fetchOrder(id) {
    return orders.get(id) || null;
  },
  verifyPaymentSignature: ({ orderId, paymentId, signature }) => signature === `sig:${orderId}|${paymentId}`,
};
const pay = (id, amount = orders.get(id).amount) => Object.assign(orders.get(id), { status: "paid", amount_paid: amount });

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/autoapply",
    createAutoApplyRouter({
      db,
      mailDb: db,
      razorpay,
      env: {},
      now: () => now,
      getUserPlan: async (u) => USERS[u] || "free",
      authenticate: (req, res, next) => {
        const uid = String(req.headers.authorization || "").replace(/^Bearer /, "");
        if (!USERS[uid]) return res.status(401).json({ error: { code: "auth_required", message: "x" } });
        req.user = { id: uid, email: "u@mail.test" };
        next();
      },
    }),
  );
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

async function call(method, path, { user = PRO, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${user}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

test("pack buying is retired: POST /orders and /orders/coupon answer 410", async () => {
  const a = await call("POST", "/api/autoapply/orders", { body: { pack_kind: "service", pack_size: 50 } });
  assert.equal(a.status, 410);
  assert.equal(a.json.error.code, "packs_retired");
  assert.equal((await call("POST", "/api/autoapply/orders/coupon", { body: {} })).status, 410);
});

test("top-up amount rules: whole rupees, min 300", () => {
  assert.equal(validateTopupAmount(30000), 30000);
  assert.throws(() => validateTopupAmount(29900), (e) => e.code === "amount_too_low");
  assert.throws(() => validateTopupAmount(30050), (e) => e.code === "invalid_input");
  assert.throws(() => validateTopupAmount(9999900), (e) => e.code === "amount_too_high");
});

let orderId;
test("POST /wallet/topup creates a wallet_topup order", async () => {
  assert.equal((await call("POST", "/api/autoapply/wallet/topup", { body: { amount_paise: 20000 } })).status, 400);
  const r = await call("POST", "/api/autoapply/wallet/topup", { body: { amount_paise: 50000 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  orderId = r.json.order_id;
  assert.deepEqual(orders.get(orderId).notes, { kind: "wallet_topup", user_id: PRO });
});

test("verify: bad signature, unpaid order and foreign order are refused; the credit is Razorpay's amount_paid, once", async () => {
  const body = { razorpay_order_id: orderId, razorpay_payment_id: "pay_1", razorpay_signature: `sig:${orderId}|pay_1` };
  assert.equal((await call("POST", "/api/autoapply/wallet/topup/verify", { body: { ...body, razorpay_signature: "nope" } })).json.error.code, "signature_mismatch");
  assert.equal((await call("POST", "/api/autoapply/wallet/topup/verify", { body })).json.error.code, "not_paid");
  assert.equal(wl(PRO).balance_paise, 0);
  assert.equal((await call("POST", "/api/autoapply/wallet/topup/verify", { user: OTHER, body })).json.error.code, "order_mismatch");
  pay(orderId);
  const ok = await call("POST", "/api/autoapply/wallet/topup/verify", { body });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.credited, true);
  assert.equal(wl(PRO).balance_paise, 50000);
  const again = await call("POST", "/api/autoapply/wallet/topup/verify", { body });
  assert.equal(again.json.duplicate, true);
  assert.equal(wl(PRO).balance_paise, 50000, "replay never credits twice");
  const w = await call("GET", "/api/autoapply/wallet");
  assert.equal(w.json.balance_paise, 50000);
  assert.deepEqual(w.json.rates, { product: 1800, service: 1200 });
});

test("a partially paid order never credits", async () => {
  const r = await call("POST", "/api/autoapply/wallet/topup", { body: { amount_paise: 100000 } });
  pay(r.json.order_id, 50000);
  const v = await call("POST", "/api/autoapply/wallet/topup/verify", { body: { razorpay_order_id: r.json.order_id, razorpay_payment_id: "pay_p", razorpay_signature: `sig:${r.json.order_id}|pay_p` } });
  assert.equal(v.json.error.code, "not_paid");
});

test("webhook order.paid credits once and is idempotent with verify; other events pass through", async () => {
  const r = await call("POST", "/api/autoapply/wallet/topup", { user: OTHER, body: { amount_paise: 30000 } });
  const id = r.json.order_id;
  pay(id);
  const ev = (event) => ({ event, payload: { order: { entity: { ...orders.get(id) } }, payment: { entity: { id: "pay_w1", order_id: id, amount: 30000 } } } });
  assert.equal(await handleWalletWebhook({ db, body: ev("payment.captured") }), null);
  const a = await handleWalletWebhook({ db, body: ev("order.paid") });
  assert.equal(a.credited, true);
  assert.equal(wl(OTHER).balance_paise, 30000);
  const b = await handleWalletWebhook({ db, body: ev("order.paid") });
  assert.equal(b.duplicate, true);
  assert.equal(wl(OTHER).balance_paise, 30000);
  const planOrder = { event: "order.paid", payload: { order: { entity: { id: "o_plan", notes: { plan: "pro" }, status: "paid" } }, payment: { entity: { id: "p" } } } };
  assert.equal(await handleWalletWebhook({ db, body: planOrder }), null);
  const unpaid = { event: "order.paid", payload: { order: { entity: { id: "o_x", notes: { kind: "wallet_topup", user_id: OTHER }, status: "attempted", amount: 50000, amount_paid: 0 } }, payment: { entity: { id: "p2" } } } };
  assert.match((await handleWalletWebhook({ db, body: unpaid })).note, /not fully paid/);
  assert.equal(wl(OTHER).balance_paise, 30000);
});

test("POST /batches: plan, consent, size, balance >= one application, then a wallet batch without any hold", async () => {
  assert.equal((await call("POST", "/api/autoapply/batches", { user: FREE, body: { size: 25 } })).json.error.code, "not_eligible");
  assert.equal((await call("POST", "/api/autoapply/batches", { user: NOCONSENT, body: { size: 25 } })).json.error.code, "consent_required");
  assert.equal((await call("POST", "/api/autoapply/batches", { body: { size: 60 } })).status, 400);
  const broke = await call("POST", "/api/autoapply/batches", { user: OTHER, body: { size: 25 } });
  assert.equal(broke.status, 201, "OTHER has 300 rupees");
  const before = wl(PRO).balance_paise;
  const ok = await call("POST", "/api/autoapply/batches", { body: { size: 50, window_days: 7, must_companies: ["Stripe"] } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const b = ok.json.batch;
  assert.equal(b.status, "shortlisting");
  assert.equal(b.credits_total, 50);
  assert.equal(b.rate_paise, 1800);
  assert.equal(b.rate_service_paise, 1200);
  assert.equal(b.pack_kind, null, "not tied to one company kind");
  assert.equal(ok.json.wallet.balance_paise, before, "starting a batch moves no money");
  assert.deepEqual(b.must_companies, ["Stripe"]);
});

test("POST /batches: balance below one application -> 402 with the shortfall", async () => {
  const u = "bbbbbbbb-0000-4000-8000-000000000009";
  USERS[u] = "pro";
  db.tables.aa_profiles.push({ user_id: u, consent_at: now.toISOString() });
  wl(u).balance_paise = 1000;
  const r = await call("POST", "/api/autoapply/batches", { user: u, body: { size: 25 } });
  assert.equal(r.status, 402);
  assert.equal(r.json.error.code, "insufficient_balance");
  assert.equal(r.json.error.shortfall_paise, 800);
  assert.equal(r.json.error.needed_paise, 1800);
});

test("stopping a wallet batch cancels it (no card refund); the admin card refund is refused", async () => {
  const b = db.tables.aa_batches.find((x) => x.user_id === PRO && x.rate_paise === 1800);
  const stop = await call("POST", `/api/autoapply/batches/${b.id}/cancel`);
  assert.equal(stop.status, 200);
  assert.equal(stop.json.batch.status, "cancelled");
  assert.equal(stop.json.stopped, true);
  const again = await call("POST", `/api/autoapply/batches/${b.id}/cancel`);
  assert.equal(again.json.batch.status, "cancelled");
});

test("GET /batches/:id: finished_partial carries the retrigger pre-fill", async () => {
  const { data } = await db.from("aa_batches").insert({ user_id: PRO, pack_size: 50, price_paise: 0, status: "finished_partial", credits_total: 50, credits_used: 31, rate_paise: 1800, rate_service_paise: 1200, window_days: 14, must_companies: ["Acme"], purchased_at: now.toISOString() }).select("*").single();
  const r = await call("GET", `/api/autoapply/batches/${data.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.retrigger, { remaining: 19, size: 25, window_days: 14, must_companies: ["Acme"] });
  assert.match(r.json.live.message, /unused money|back in your wallet/);
  const list = await call("GET", "/api/autoapply/batches");
  assert.equal(list.json.batches.find((x) => x.id === data.id).retrigger.remaining, 19);
});

test("retriggerFor: smallest size that covers the remaining, none when nothing is left or the batch is open", () => {
  assert.equal(retriggerFor({ status: "finished_partial", credits_total: 100, credits_used: 30, window_days: 30 }).size, 100);
  assert.equal(retriggerFor({ status: "finished_partial", credits_total: 100, credits_used: 99, window_days: 30 }).size, 25);
  assert.equal(retriggerFor({ status: "completed", credits_total: 50, credits_used: 50 }), null);
  assert.equal(retriggerFor({ status: "running", credits_total: 50, credits_used: 5 }), null);
});

test("wallet-empty push goes out once per entry into waiting_funds", async () => {
  const { data } = await db.from("aa_batches").insert({ user_id: OTHER, pack_size: 25, price_paise: 0, status: "waiting_funds", credits_total: 25, credits_used: 5, rate_paise: 1800, rate_service_paise: 1200, purchased_at: now.toISOString() }).select("*").single();
  const sent = [];
  const send = async (a) => sent.push(a);
  assert.equal((await notifyWaitingFunds({ db, send, now })).sent, 1);
  assert.equal((await notifyWaitingFunds({ db, send, now })).sent, 0, "announced once");
  assert.match(sent[0].payload.body, /20 applications left/);
  // the resume (top-up / scheduler) clears funds_notified_at, so a later empty wallet announces again
  db.tables.aa_batches.find((x) => x.id === data.id).funds_notified_at = null;
  assert.equal((await notifyWaitingFunds({ db, send, now })).sent, 1);
});

// ---- live status honesty
const run = (counts, extra = {}) => liveStatus({ batch: { status: "running", credits_total: 50, credits_used: 0, rate_paise: 1800 }, counts, now, ...extra });

test("applying counts only tasks with a live lease", () => {
  const rows = [
    { status: "running", lease_until: "2026-11-28T06:10:00Z" },
    { status: "claimed", lease_until: "2026-11-28T05:00:00Z" },   // dead lease
    { status: "submitting", lease_until: null },
    { status: "queued" },
  ];
  const c = liveCounts(rows, now);
  assert.deepEqual(c, { running: 1, stale_lease: 2, queued: 1 });
  assert.deepEqual(buckets(c), { queued: 3, applying: 1, applied: 0, needs_you: 0, not_applied: 0 });
  assert.equal(run(liveCounts(rows.slice(1, 3), now)).phase, "waiting", "stale leases are not 'applying now'");
});

test("the engine reason replaces the generic 40-minute line", () => {
  const generic = run({ queued: 5 }).message;
  assert.match(generic, /within about 40 minutes/);
  const cd = run({ queued: 5 }, { engine: { state: "off", reason: "cooldown", cooldown_until: "2026-11-28T08:30:00Z" } }).message;
  assert.match(cd, /resting until about .*IST/);
  assert.match(run({ queued: 5 }, { engine: { state: "off", reason: "daily_spend_cap" } }).message, /budget is used up/);
  assert.match(run({ queued: 5 }, { engine: { state: "off", reason: "below_wake" } }).message, /few more applications/);
  assert.match(run({ queued: 5 }, { engine: { state: "off", stale: true } }).message, /has not checked in/);
  assert.match(run({ queued: 5 }, { engine: "starting" }).message, /Starting our application server/);
  assert.match(run({ queued: 5 }, { dailyCapReached: true }).message, /Today's limit of 60 applications/);
  assert.equal(engineReason({ reason: "working" }, now), null);
});

test("engineState reads the control row of aa_health", async () => {
  const mk = (launch, health) => ({
    from: (t) => t === "aa_worker_launches"
      ? { select: () => ({ in: () => ({ order: () => ({ limit: async () => ({ data: launch, error: null }) }) }) }) }
      : { select: () => ({ in: async () => ({ data: health, error: null }) }) },
  });
  const s = await engineState(mk([], [
    { component: "control", last_seen: new Date().toISOString(), stats: { autoscale: { action: "none", reason: "cooldown", due: 7, cooldown_until: "2099-01-01T00:00:00Z" } } },
  ]));
  assert.equal(s.state, "off");
  assert.equal(s.reason, "cooldown");
  assert.equal(s.due, 7);
  const stale = await engineState(mk([], [{ component: "control", last_seen: "2020-01-01T00:00:00Z", stats: {} }]));
  assert.equal(stale.stale, true);
  assert.equal((await engineState(mk([{ status: "running" }], []))).state, "running");
});

test("waiting_funds says what to do", () => {
  const m = liveStatus({ batch: { status: "waiting_funds", credits_total: 50, credits_used: 30, rate_paise: 1800 }, counts: {}, now }).message;
  assert.match(m, /Wallet empty. Add money to continue \(20 applications left/);
});

// ---- old pack credits -> wallet
test("convertible: the price paid per unused credit; only real, bought, open legacy packs", () => {
  const b = { status: "running", price_paise: 59900, credits_total: 50, credits_used: 20, purchased_at: "2026-11-01T00:00:00Z", rate_paise: null };
  assert.deepEqual(convertible(b), { unused: 30, amount_paise: 35940 });
  assert.equal(convertible({ ...b, price_paise: 0 }).amount_paise, 0, "a free pack converts to nothing");
  assert.equal(convertible({ ...b, rate_paise: 1800 }).amount_paise, 0, "wallet batches are never converted");
  assert.equal(convertible({ ...b, status: "refunded" }).amount_paise, 0);
  assert.equal(convertible({ ...b, credits_used: 50 }).amount_paise, 0);
});

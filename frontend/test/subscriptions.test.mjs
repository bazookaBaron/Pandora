import test from "node:test";
import assert from "node:assert/strict";
import { reduceSubscriptionEvent, GRACE_MS } from "../lib/subscriptionEvents.js";
import { effectivePlanFromRow, planAtLeast, subscriptionView } from "../lib/entitlements.js";
import { planId, planFromRazorpayPlanId, subscriptionsConfigured, subscriptionsEnabled } from "../services/razorpay.js";
import { trustProxyHops, shouldRedetectCountry, countryFromHeaders } from "../lib/geo.js";

const NOW = Date.parse("2026-06-15T00:00:00Z");
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const ENV = {
  RAZORPAY_KEY_ID: "k",
  RAZORPAY_KEY_SECRET: "s",
  RAZORPAY_SUBSCRIPTIONS_ENABLED: "true",
  RAZORPAY_PLAN_PRO_MONTHLY: "plan_pm",
  RAZORPAY_PLAN_PRO_YEARLY: "plan_py",
  RAZORPAY_PLAN_MAX_MONTHLY: "plan_mm",
  RAZORPAY_PLAN_MAX_YEARLY: "plan_my",
  RAZORPAY_PLAN_PRO_MONTHLY_USD: "plan_pm_usd",
};
const resolvePlan = (id) => planFromRazorpayPlanId(id, ENV);
const row = (o = {}) => ({
  user_id: "u1",
  plan: "pro",
  status: "active",
  provider: "razorpay",
  provider_subscription_id: "sub_B",
  billing_period: "monthly",
  current_period_end: "2026-06-20T00:00:00Z",
  last_event_at: null,
  ...o,
});
const run = (event, o) => reduceSubscriptionEvent({ event, now: NOW, resolvePlan, subscriptionId: "sub_B", ...o });

test("stale event for an OLD subscription never touches the row of a newer one", () => {
  const r = run("subscription.cancelled", { subscriptionId: "sub_A", entity: { id: "sub_A", status: "cancelled" }, stored: row() });
  assert.deepEqual(r, { action: "ignore", reason: "subscription_mismatch" });
  assert.equal(run("subscription.halted", { subscriptionId: "sub_A", entity: { id: "sub_A" }, stored: row() }).action, "ignore");
  assert.equal(run("payment.failed", { subscriptionId: "sub_A", payment: { id: "pay_1" }, stored: row() }).action, "ignore");
});
test("no stored row -> ignored", () => {
  assert.equal(run("subscription.charged", { entity: { id: "sub_B" }, stored: null }).reason, "no_matching_row");
});
test("older-than-last event is ignored (out of order)", () => {
  const r = run("subscription.halted", {
    entity: { id: "sub_B" },
    stored: row({ last_event_at: "2026-06-14T12:00:00Z" }),
    eventCreatedMs: Date.parse("2026-06-14T00:00:00Z"),
  });
  assert.equal(r.reason, "stale_event");
});

test("activated: active, plan/period/currency from plan id, period end from current_end", () => {
  const r = run("subscription.activated", {
    stored: row({ plan: "pro", status: "created", current_period_end: null }),
    entity: { id: "sub_B", plan_id: "plan_my", customer_id: "cust_1", current_end: sec("2026-07-15T00:00:00Z") },
  });
  assert.equal(r.action, "patch");
  assert.equal(r.patch.status, "active");
  assert.equal(r.patch.plan, "max");
  assert.equal(r.patch.billing_period, "yearly");
  assert.equal(r.patch.currency, "INR");
  assert.equal(r.patch.current_period_end, "2026-07-15T00:00:00.000Z");
  assert.equal(r.patch.grace_until, null);
  assert.equal(r.patch.cancel_at_period_end, false);
});
test("USD plan ids resolve to USD", () => {
  assert.deepEqual(resolvePlan("plan_pm_usd"), { plan: "pro", period: "monthly", currency: "USD" });
});

test("charged: extends current_period_end from current_end, clears grace, writes audit row", () => {
  const r = run("subscription.charged", {
    stored: row({ status: "past_due", grace_until: "2026-06-16T00:00:00Z" }),
    entity: { id: "sub_B", plan_id: "plan_pm", current_end: sec("2026-07-20T00:00:00Z") },
    payment: { id: "pay_9", order_id: "order_9", amount: 19900, currency: "INR" },
  });
  assert.equal(r.patch.status, "active");
  assert.equal(r.patch.current_period_end, "2026-07-20T00:00:00.000Z");
  assert.equal(r.patch.grace_until, null);
  assert.deepEqual(
    { id: r.audit.payment_id, order: r.audit.order_id, amount: r.audit.amount, cur: r.audit.currency, src: r.audit.source, user: r.audit.user_id, end: r.audit.period_end },
    { id: "pay_9", order: "order_9", amount: 19900, cur: "INR", src: "webhook", user: "u1", end: "2026-07-20T00:00:00.000Z" },
  );
});
test("charged never moves the paid-through date backwards on the same plan", () => {
  const r = run("subscription.charged", {
    stored: row({ current_period_end: "2026-08-01T00:00:00Z" }),
    entity: { id: "sub_B", plan_id: "plan_pm", current_end: sec("2026-07-01T00:00:00Z") },
  });
  assert.equal(r.patch.current_period_end, "2026-08-01T00:00:00.000Z");
});
test("audit row only with a payment entity; order id falls back to sub_<payment>", () => {
  const e = { id: "sub_B", plan_id: "plan_pm", current_end: sec("2026-07-20T00:00:00Z") };
  assert.equal(run("subscription.charged", { stored: row(), entity: e }).audit, undefined);
  assert.equal(run("subscription.charged", { stored: row(), entity: e, payment: { id: "pay_1", amount: 1 } }).audit.order_id, "sub_pay_1");
});
test("charged applying a scheduled Pro->Max change clears pending_plan", () => {
  const r = run("subscription.charged", {
    stored: row({ plan: "pro", pending_plan: "max" }),
    entity: { id: "sub_B", plan_id: "plan_mm", current_end: sec("2026-07-20T00:00:00Z") },
  });
  assert.equal(r.patch.plan, "max");
  assert.equal(r.patch.pending_plan, null);
});

test("payment.failed on a paid subscription -> past_due with a 3-day grace, then Free", () => {
  const evMs = Date.parse("2026-06-20T01:00:00Z");
  const r = run("payment.failed", { stored: row(), payment: { id: "pay_f" }, eventCreatedMs: evMs });
  assert.equal(r.patch.status, "past_due");
  assert.equal(r.patch.grace_until, new Date(evMs + GRACE_MS).toISOString());
  const merged = { ...row(), ...r.patch };
  assert.equal(effectivePlanFromRow(merged, evMs + 2 * 86400000), "pro");
  assert.equal(effectivePlanFromRow(merged, evMs + 3 * 86400000 + 1000), "free");
});
test("repeat failures do not extend the grace window", () => {
  const first = "2026-06-21T00:00:00.000Z";
  const r = run("payment.failed", {
    stored: row({ status: "past_due", grace_until: first }),
    payment: { id: "pay_f2" },
    eventCreatedMs: Date.parse("2026-06-22T00:00:00Z"),
  });
  assert.equal(r.patch.grace_until, first);
});
test("failed FIRST payment (row still 'created') changes nothing", () => {
  const r = run("payment.failed", { stored: row({ status: "created", current_period_end: null }), payment: { id: "pay_f" } });
  assert.equal(r.action, "ignore");
});
test("subscription.pending behaves like a failed renewal", () => {
  const r = run("subscription.pending", { stored: row(), entity: { id: "sub_B" } });
  assert.equal(r.patch.status, "past_due");
  assert.ok(r.patch.grace_until);
});

test("halted: Free immediately", () => {
  const stored = row({ current_period_end: "2026-12-01T00:00:00Z" });
  const r = run("subscription.halted", { stored, entity: { id: "sub_B" } });
  assert.equal(r.patch.status, "halted");
  assert.equal(effectivePlanFromRow({ ...stored, ...r.patch }, NOW), "free");
});
test("cancelled/completed: access kept to current_period_end then Free", () => {
  const r = run("subscription.cancelled", { stored: row(), entity: { id: "sub_B" } });
  assert.equal(r.patch.status, "cancelled");
  assert.equal(r.patch.cancel_at_period_end, true);
  const merged = { ...row(), ...r.patch };
  assert.equal(effectivePlanFromRow(merged, NOW), "pro");
  assert.equal(effectivePlanFromRow(merged, Date.parse("2026-06-21T00:00:00Z")), "free");
  assert.equal(run("subscription.completed", { stored: row(), entity: { id: "sub_B" } }).patch.status, "cancelled");
});
test("unhandled events are ignored", () => {
  assert.equal(run("subscription.authenticated", { stored: row(), entity: { id: "sub_B" } }).action, "ignore");
});

test("planAtLeast", () => {
  assert.ok(planAtLeast("max", "pro") && planAtLeast("pro", "pro") && !planAtLeast("free", "pro") && !planAtLeast("pro", "max"));
});
test("subscriptionView: recurring can cancel; cancelling cannot; legacy order cannot; halted hidden", () => {
  const live = row({ current_period_end: "2026-07-01T00:00:00Z" });
  assert.equal(subscriptionView(live, NOW).can_cancel, true);
  assert.equal(subscriptionView({ ...live, cancel_at_period_end: true }, NOW).can_cancel, false);
  assert.equal(subscriptionView({ ...live, provider_subscription_id: "order_X" }, NOW).can_cancel, false);
  assert.equal(subscriptionView({ ...live, status: "halted" }, NOW), null);
});

test("per-currency plan ids; kill switch; incomplete currency -> not configured", () => {
  assert.equal(planId("pro", "monthly", "INR", ENV), "plan_pm");
  assert.equal(planId("pro", "monthly", "USD", ENV), "plan_pm_usd");
  assert.equal(planId("max", "yearly", "USD", ENV), null);
  assert.equal(subscriptionsConfigured("INR", ENV), true);
  assert.equal(subscriptionsConfigured("USD", ENV), false);
  assert.equal(subscriptionsConfigured("INR", { ...ENV, RAZORPAY_SUBSCRIPTIONS_ENABLED: "" }), false);
  assert.equal(subscriptionsEnabled({ RAZORPAY_SUBSCRIPTIONS_ENABLED: "off" }), false);
});

test("geo: proxy hops configurable; header only when trusted; re-detect unless user-set", () => {
  assert.equal(trustProxyHops({}), 1);
  assert.equal(trustProxyHops({ TRUST_PROXY_HOPS: "2" }), 2);
  assert.equal(trustProxyHops({ TRUST_PROXY_HOPS: "0" }), 0);
  assert.equal(trustProxyHops({ TRUST_PROXY_HOPS: "banana" }), 1);
  const req = { headers: { "cf-ipcountry": "in" } };
  const prev = process.env.TRUST_GEO_HEADERS;
  delete process.env.TRUST_GEO_HEADERS;
  assert.equal(countryFromHeaders(req), null);
  process.env.TRUST_GEO_HEADERS = "true";
  assert.equal(countryFromHeaders(req), "IN");
  if (prev === undefined) delete process.env.TRUST_GEO_HEADERS;
  else process.env.TRUST_GEO_HEADERS = prev;
  assert.equal(shouldRedetectCountry({ country: "US", country_source: "ip" }), true);
  assert.equal(shouldRedetectCountry({ country: "US", country_source: null }), true);
  assert.equal(shouldRedetectCountry({ country: "US", country_source: "user" }), false);
  assert.equal(shouldRedetectCountry({ country: null }), true);
});

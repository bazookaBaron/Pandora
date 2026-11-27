/**
 * Razorpay — SERVER ONLY.
 *
 * Pro / Max are sold ONLY as recurring Razorpay Subscriptions (see the
 * "Subscriptions" section below). The one-time Orders helpers at the top
 * (createOrder / fetchOrder / verifyPaymentSignature / refund*) remain for
 * AutoApply packs and wallet top-ups, which are not plans.
 *
 * DORMANT when RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are unset: isEnabled()
 * is false and the routes 503. KEY_SECRET never leaves this module.
 */
import crypto from "node:crypto";
import Razorpay from "razorpay";
import { redact } from "../lib/aiClient.js";

let _client = null;
function client() {
  if (!isEnabled()) {
    const e = new Error("Razorpay is not configured.");
    e.status = 503;
    throw e;
  }
  if (!_client) {
    _client = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return _client;
}

export function isEnabled() {
  return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

/** Public key — safe to send to the browser. */
export function keyId() {
  return process.env.RAZORPAY_KEY_ID || null;
}

/**
 * Create an order. `amountPaise` must be a positive integer >= 100.
 * @returns {Promise<{ id, amount, currency, receipt, status, notes }>}
 */
export async function createOrder({ amountPaise, currency = "INR", receipt, notes }) {
  const amount = Math.round(Number(amountPaise));
  if (!Number.isInteger(amount) || amount < 100) {
    const e = new Error("amount must be an integer >= 100 paise.");
    e.status = 400;
    throw e;
  }
  try {
    return await client().orders.create({
      amount,
      currency,
      receipt: String(receipt || `rcpt_${Date.now()}`).slice(0, 40),
      notes: notes || {},
      payment_capture: 1,
    });
  } catch (err) {
    const msg = redact((err && (err.error?.description || err.message)) || String(err));
    console.error("[razorpay] createOrder failed:", msg);
    const e = new Error("Could not create the payment order.");
    e.status = 502;
    throw e;
  }
}

/** Fetch an order back from Razorpay (authoritative amount / notes / status). */
export async function fetchOrder(orderId) {
  try {
    return await client().orders.fetch(String(orderId));
  } catch (err) {
    console.error("[razorpay] fetchOrder failed:", redact((err && err.message) || String(err)));
    return null;
  }
}

/**
 * Verify the one-time checkout callback signature.
 * HMAC-SHA256(order_id + "|" + payment_id, KEY_SECRET) === razorpay_signature
 */
export function verifyPaymentSignature({ orderId, paymentId, signature }) {
  return hmacEquals(`${orderId}|${paymentId}`, signature);
}

// ── Refunds (AutoApply unused-credit refunds) ─────────────────────
/**
 * Refund part (or all) of a captured payment. `amountPaise` integer >= 100.
 * `notes` should carry our batch id so a retry can find an earlier refund.
 * Throws (status 502) on failure so the caller can retry later.
 */
export async function refundPayment(paymentId, { amountPaise, notes, receipt } = {}) {
  const amount = Math.round(Number(amountPaise));
  if (!paymentId || !Number.isInteger(amount) || amount < 100) {
    const e = new Error("refund needs a payment id and an amount >= 100 paise.");
    e.status = 400;
    throw e;
  }
  try {
    return await client().payments.refund(String(paymentId), {
      amount,
      speed: "normal",
      notes: notes || {},
      ...(receipt ? { receipt: String(receipt).slice(0, 40) } : {}),
    });
  } catch (err) {
    const msg = redact((err && (err.error?.description || err.message)) || String(err));
    console.error("[razorpay] refund failed:", msg);
    const e = new Error("Could not create the refund.");
    e.status = 502;
    throw e;
  }
}

/** List refunds already made on a payment ([] on failure). */
export async function listRefunds(paymentId) {
  try {
    const r = await client().payments.fetchMultipleRefund(String(paymentId), { count: 100 });
    return (r && Array.isArray(r.items) && r.items) || [];
  } catch (err) {
    console.error("[razorpay] listRefunds failed:", redact((err && err.message) || String(err)));
    return null;
  }
}

// ── Subscriptions ─────────────────────────────────────────────────
// Recurring billing against pre-created Razorpay Plans. Env:
//   RAZORPAY_SUBSCRIPTIONS_ENABLED=true            (kill switch, default OFF)
//   RAZORPAY_PLAN_{PRO,MAX}_{MONTHLY,YEARLY}       INR plans (match price_inr)
//   RAZORPAY_PLAN_{PRO,MAX}_{MONTHLY,YEARLY}_USD   USD plans (match price)
//   RAZORPAY_WEBHOOK_SECRET
// Each plan must be created in the Razorpay dashboard (Subscriptions -> Plans)
// in the matching currency, period and amount from config/tiers.js.

export const CURRENCIES = ["INR", "USD"];

function planEnvName(plan, period, currency = "INR") {
  const base = `RAZORPAY_PLAN_${String(plan).toUpperCase()}_${String(period).toUpperCase()}`;
  return currency === "USD" ? `${base}_USD` : base;
}

const PLAN_KEYS = [
  ["pro", "monthly"],
  ["pro", "yearly"],
  ["max", "monthly"],
  ["max", "yearly"],
];

/** Razorpay plan id for (plan, period, currency), or null. */
export function planId(plan, period, currency = "INR", env = process.env) {
  return env[planEnvName(plan, period, currency)] || null;
}

/** Reverse lookup: Razorpay plan id -> { plan, period, currency } (or null). */
export function planFromRazorpayPlanId(rzpPlanId, env = process.env) {
  if (!rzpPlanId) return null;
  for (const currency of CURRENCIES) {
    for (const [plan, period] of PLAN_KEYS) {
      if (env[planEnvName(plan, period, currency)] === rzpPlanId) return { plan, period, currency };
    }
  }
  return null;
}

/** The kill switch alone (RAZORPAY_SUBSCRIPTIONS_ENABLED). */
export function subscriptionsEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test((env.RAZORPAY_SUBSCRIPTIONS_ENABLED || "").trim());
}

/**
 * True only when the kill switch is on AND the key pair + all four plan ids for
 * `currency` are present. When false the pricing page shows "coming soon";
 * there is NO fallback to one-time payments for plans.
 */
export function subscriptionsConfigured(currency = "INR", env = process.env) {
  return (
    subscriptionsEnabled(env) &&
    !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) &&
    PLAN_KEYS.every(([p, per]) => !!env[planEnvName(p, per, currency)])
  );
}

/** Create a Razorpay customer. `notes` may carry our user_id. */
export async function createCustomer({ name, email, notes }) {
  try {
    return await client().customers.create({
      name: name || email || "Vloombox user",
      email: email || undefined,
      fail_existing: 0, // return the existing customer instead of erroring
      notes: notes || {},
    });
  } catch (err) {
    console.error("[razorpay] createCustomer failed:", redact((err && (err.error?.description || err.message)) || String(err)));
    const e = new Error("Could not create the billing customer.");
    e.status = 502;
    throw e;
  }
}

/**
 * Create a subscription against a plan id.
 * @returns the Razorpay subscription object ({ id, status, short_url, ... }).
 */
export async function createSubscription({ planIdValue, customerId, totalCount, notes }) {
  if (!planIdValue) {
    const e = new Error("plan is not configured.");
    e.status = 400;
    throw e;
  }
  try {
    return await client().subscriptions.create({
      plan_id: planIdValue,
      customer_id: customerId || undefined,
      total_count: totalCount || 120, // ~10 yrs of monthly / plenty of yearly cycles
      quantity: 1,
      customer_notify: 1,
      notes: notes || {},
    });
  } catch (err) {
    console.error("[razorpay] createSubscription failed:", redact((err && (err.error?.description || err.message)) || String(err)));
    const e = new Error("Could not start the subscription.");
    e.status = 502;
    throw e;
  }
}

/**
 * Cancel a subscription. cancelAtCycleEnd=true keeps it running (and the user
 * paid-for) until the end of the current cycle, then stops renewals.
 */
export async function cancelSubscription(subscriptionId, cancelAtCycleEnd = true) {
  try {
    return await client().subscriptions.cancel(String(subscriptionId), cancelAtCycleEnd ? 1 : 0);
  } catch (err) {
    const desc = (err && (err.error?.description || err.message)) || String(err);
    console.error("[razorpay] cancelSubscription failed:", redact(desc));
    const e = new Error(/already|cancelled|completed/i.test(desc) ? "already_cancelled" : "Could not cancel the subscription.");
    e.status = /already|cancelled|completed/i.test(desc) ? 409 : 502;
    throw e;
  }
}

/**
 * Schedule a plan change at the end of the current cycle (Razorpay update).
 * Razorpay may refuse (e.g. UPI mandates, different period); callers surface that.
 */
export async function scheduleSubscriptionPlanChange(subscriptionId, newPlanId) {
  try {
    return await client().subscriptions.update(String(subscriptionId), {
      plan_id: newPlanId,
      schedule_change_at: "cycle_end",
      customer_notify: 1,
    });
  } catch (err) {
    console.error("[razorpay] planChange failed:", redact((err && (err.error?.description || err.message)) || String(err)));
    const e = new Error("change_unsupported");
    e.status = 409;
    throw e;
  }
}

/** Fetch an invoice (used to map a payment.failed back to its subscription). */
export async function fetchInvoice(invoiceId) {
  try {
    return await client().invoices.fetch(String(invoiceId));
  } catch (err) {
    console.error("[razorpay] fetchInvoice failed:", redact((err && err.message) || String(err)));
    return null;
  }
}

export async function fetchSubscription(subscriptionId) {
  try {
    return await client().subscriptions.fetch(String(subscriptionId));
  } catch (err) {
    console.error("[razorpay] fetchSubscription failed:", redact((err && err.message) || String(err)));
    return null;
  }
}

/**
 * Verify the Checkout success callback for a subscription:
 * HMAC-SHA256(payment_id + "|" + subscription_id, KEY_SECRET) === signature
 */
export function verifySubscriptionSignature({ paymentId, subscriptionId, signature }) {
  return hmacEquals(`${paymentId}|${subscriptionId}`, signature);
}

/** Verify an inbound webhook body against RAZORPAY_WEBHOOK_SECRET. */
export function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature || !rawBody) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
  try {
    return Razorpay.validateWebhookSignature(body, String(signature), secret);
  } catch {
    return hmacEquals(body, signature, secret);
  }
}

// ── internal ──────────────────────────────────────────────────────
function hmacEquals(payload, signature, secret) {
  const key = secret || process.env.RAZORPAY_KEY_SECRET;
  if (!payload || !signature || !key) return false;
  const expected = crypto.createHmac("sha256", key).update(payload).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

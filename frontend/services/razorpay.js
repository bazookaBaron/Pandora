/**
 * Razorpay Standard Checkout — SERVER ONLY.
 *
 * One-time payments that grant a plan for a fixed term (monthly / yearly).
 * There is no recurring billing: when the term lapses, the entitlements
 * "lazy check-on-access" (lib/entitlements.js) drops the user back to free,
 * and they re-purchase. This matches Razorpay's Orders + signature-verify
 * flow and the app's existing subscription model.
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

// ── Subscriptions ─────────────────────────────────────────────────
// Recurring billing against pre-created Razorpay Plans. Env:
//   RAZORPAY_PLAN_PRO_MONTHLY / _PRO_YEARLY / _MAX_MONTHLY / _MAX_YEARLY
//   RAZORPAY_WEBHOOK_SECRET
// TODO: fill the four PLAN ids from the Razorpay dashboard (Subscriptions →
// Plans). Each must be an INR recurring plan matching config/tiers.js price_inr.

const PLAN_ENV = {
  "pro:monthly": "RAZORPAY_PLAN_PRO_MONTHLY",
  "pro:yearly": "RAZORPAY_PLAN_PRO_YEARLY",
  "max:monthly": "RAZORPAY_PLAN_MAX_MONTHLY",
  "max:yearly": "RAZORPAY_PLAN_MAX_YEARLY",
};

export function planId(plan, period) {
  const env = PLAN_ENV[`${plan}:${period}`];
  return (env && process.env[env]) || null;
}

/**
 * True when the key pair + all four plan ids are present. The webhook secret
 * is strongly recommended (renewal / cancel / halt sync) but not required to
 * open checkout — /api/webhooks/razorpay 503s on its own until it is set.
 */
export function subscriptionsConfigured() {
  return isEnabled() && Object.values(PLAN_ENV).every((e) => !!process.env[e]);
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

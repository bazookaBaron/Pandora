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
 * Verify the checkout callback signature.
 * HMAC-SHA256(order_id + "|" + payment_id, KEY_SECRET) === razorpay_signature
 */
export function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature) return false;
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

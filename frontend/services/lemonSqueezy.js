/**
 * Lemon Squeezy integration — ALL provider-specific logic is isolated here.
 *
 * Dormant-safe: if the API key, the webhook secret, or the store/variant config
 * is missing, `isEnabled()` is false and the server.js routes answer 503 without
 * ever touching the network.
 *
 * Nothing here logs the API key. On an upstream failure the caller gets a
 * redacted, generic error tagged with an HTTP-ish `status`.
 */
import crypto from "node:crypto";

import {
  VARIANT_TO_PLAN,
  planVariant,
  storeId,
  isConfigured,
} from "../config/lemonSqueezy.js";

const LS_API = "https://api.lemonsqueezy.com/v1";

// LS event names this integration acts on (the "7 handled events").
const UPSERT_EVENTS = new Set([
  "subscription_created",
  "subscription_updated",
  "subscription_resumed",
  "subscription_plan_changed",
]);
const LAPSE_EVENTS = new Set([
  "subscription_cancelled",
  "subscription_expired",
  "subscription_payment_failed",
]);
export const HANDLED_EVENTS = new Set([...UPSERT_EVENTS, ...LAPSE_EVENTS]);

function tagged(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** True only when the API key, the webhook secret, and the store/variant config all exist. */
export function isEnabled() {
  return (
    !!process.env.LEMONSQUEEZY_API_KEY &&
    !!process.env.LEMONSQUEEZY_WEBHOOK_SECRET &&
    isConfigured()
  );
}

/** Whether an event is one of the "write the full row" kind. */
export function isUpsertEvent(event) {
  return UPSERT_EVENTS.has(event);
}

/**
 * Create a hosted Lemon Squeezy checkout and return its URL.
 *
 * @param {{ userId: string, email: string, plan: "pro"|"max",
 *           billingPeriod: "monthly"|"yearly", redirectUrl: string }} args
 * @returns {Promise<string>} the hosted checkout URL
 * @throws  tagged Error — { status: 503 } not configured, { status: 400 } bad
 *          plan/billing pair, { status: 502 } upstream failure
 */
export async function createCheckout({
  userId,
  email,
  plan,
  billingPeriod,
  redirectUrl,
}) {
  if (!isEnabled()) throw tagged(503, "Checkout is not configured yet.");

  const variantId = planVariant(plan, billingPeriod);
  if (!variantId) throw tagged(400, "Unknown plan or billing period.");

  const payload = {
    data: {
      type: "checkouts",
      attributes: {
        checkout_data: {
          email,
          custom: { user_id: String(userId) },
        },
        product_options: {
          redirect_url: redirectUrl,
        },
      },
      relationships: {
        store: { data: { type: "stores", id: String(storeId()) } },
        variant: { data: { type: "variants", id: String(variantId) } },
      },
    },
  };

  let res;
  try {
    res = await fetch(`${LS_API}/checkouts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`,
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw tagged(502, "Could not reach the checkout provider.");
  }

  if (!res.ok) {
    // Drain the upstream body so it can't leak (it may echo request headers).
    await res.text().catch(() => "");
    throw tagged(502, `Checkout provider returned ${res.status}.`);
  }

  const json = await res.json().catch(() => null);
  const url = json && json.data && json.data.attributes && json.data.attributes.url;
  if (!url) throw tagged(502, "Checkout provider returned no URL.");
  return url;
}

/**
 * Constant-time verify of `X-Signature` against HMAC-SHA256(rawBody, secret).
 * @param {Buffer} rawBodyBuffer  the exact bytes express.json captured
 * @param {string} signatureHeader  the request's X-Signature header
 * @returns {boolean}
 */
export function verifyWebhookSignature(rawBodyBuffer, signatureHeader) {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret || !rawBodyBuffer || !rawBodyBuffer.length) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBodyBuffer)
    .digest("hex");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(String(signatureHeader || ""), "utf8");
  if (a.length !== b.length) return false; // guard timingSafeEqual's length req
  return crypto.timingSafeEqual(a, b);
}

/**
 * Normalize a parsed webhook body into the fields the route needs.
 * Body shape: { meta: { event_name, custom_data }, data: { id, attributes } }.
 *
 * Fallbacks (both noted in the report):
 *   • userId — if `meta.custom_data.user_id` is absent, the route matches
 *     `attributes.customer_id` against an existing `provider_customer_id`.
 *   • plan / billing_period — if the variant id isn't in VARIANT_TO_PLAN, infer
 *     from `attributes.variant_name` ("max" -> max, else pro; "year"/"annual"
 *     -> yearly, else monthly).
 */
export function mapWebhook(evt) {
  const meta = (evt && evt.meta) || {};
  const data = (evt && evt.data) || {};
  const attrs = data.attributes || {};

  const variantId = attrs.variant_id != null ? String(attrs.variant_id) : null;
  const mapped = variantId ? VARIANT_TO_PLAN[variantId] : null;
  const variantName = String(attrs.variant_name || "").toLowerCase();

  const planFromVariant =
    (mapped && mapped.plan) || (variantName.includes("max") ? "max" : "pro");

  let billingPeriod = (mapped && mapped.billing_period) || null;
  if (!billingPeriod) {
    if (/year|annual|yr\b/.test(variantName)) billingPeriod = "yearly";
    else billingPeriod = "monthly";
  }

  const userId =
    meta.custom_data && meta.custom_data.user_id != null
      ? String(meta.custom_data.user_id)
      : null;

  return {
    event: meta.event_name || null,
    userId,
    fromMap: !!mapped, // true when plan/billing came from VARIANT_TO_PLAN
    providerSubscriptionId: data.id != null ? String(data.id) : null,
    providerCustomerId:
      attrs.customer_id != null ? String(attrs.customer_id) : null,
    variantId,
    planFromVariant,
    billingPeriod,
    currentPeriodEnd: attrs.renews_at || attrs.ends_at || null,
    lsStatus: attrs.status || null,
  };
}

/**
 * Map an LS event (+ its status) to our `subscriptions.status` value.
 *
 *   created / updated / resumed / plan_changed → derived from lsStatus
 *   cancelled        → 'cancelled'  (plan + current_period_end kept: lazy
 *                                    check-on-access preserves access to
 *                                    period end — no cron)
 *   expired          → 'expired'
 *   payment_failed   → 'past_due'   (access kept through LS dunning; getUserPlan
 *                                    keeps the plan while current_period_end >
 *                                    now, so it lapses naturally when the period
 *                                    ends without a successful renewal)
 */
export function statusForEvent(event, lsStatus, _currentPeriodEnd) {
  if (event === "subscription_cancelled") return "cancelled";
  if (event === "subscription_expired") return "expired";
  if (event === "subscription_payment_failed") return "past_due";

  if (UPSERT_EVENTS.has(event)) {
    switch (lsStatus) {
      case "active":
        return "active";
      case "on_trial":
        return "on_trial";
      case "paused":
        return "paused";
      case "past_due":
      case "unpaid":
        return "past_due";
      case "cancelled":
        return "cancelled";
      case "expired":
        return "expired";
      default:
        return "active";
    }
  }
  return "active";
}

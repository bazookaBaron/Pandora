/**
 * AutoApply orders: create a pending batch + Razorpay order, verify the
 * checkout callback, and the idempotent "mark paid" step shared with the
 * Razorpay webhook (payment.captured / order.paid with notes.kind='autoapply').
 *
 * Idempotency: the batch flips pending_payment -> paid with a conditional
 * update (only one caller wins), and the ledger 'purchase' row is protected by
 * the unique index uq_aa_ledger_purchase, so every caller may (re)try the
 * ledger insert — a duplicate (23505) is treated as success.
 */
import { AUTO_APPLY } from "../../config/tiers.js";
import { isEligiblePlan, monthPurchased, packPrice } from "./limits.js";

export class AAError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const DAY_MS = 86400000;
const isDup = (err) => err && (err.code === "23505" || /duplicate key/i.test(String(err.message || "")));

export function validateOrderInput(body) {
  const { pack_kind, pack_size, window_days } = body || {};
  if (!["service", "product"].includes(pack_kind)) {
    throw new AAError(400, "invalid_input", "pack_kind must be 'service' or 'product'.");
  }
  const size = Number(pack_size);
  if (![50, 80, 100].includes(size)) throw new AAError(400, "invalid_input", "pack_size must be 50, 80 or 100.");
  const wd = window_days === undefined || window_days === null ? AUTO_APPLY.window_days_default : Number(window_days);
  if (!Number.isInteger(wd) || wd < 1 || wd > AUTO_APPLY.window_days_max) {
    throw new AAError(400, "invalid_input", `window_days must be an integer 1..${AUTO_APPLY.window_days_max}.`);
  }
  const price = packPrice(pack_kind, size);
  if (!price) throw new AAError(400, "invalid_input", "Pack price is not configured.");
  return { pack_kind, pack_size: size, window_days: wd, price_paise: price };
}

export async function createAutoApplyOrder({ db, razorpay, getUserPlan, userId, body, now = new Date() }) {
  const input = validateOrderInput(body);
  const plan = await getUserPlan(userId);
  if (!isEligiblePlan(plan)) throw new AAError(403, "not_eligible", "AutoApply needs an active Pro or Max plan.");
  if (!razorpay.isEnabled()) throw new AAError(503, "checkout_unconfigured", "Payments are not configured.");

  const purchased = await monthPurchased(db, userId, now);
  if (purchased + input.pack_size > AUTO_APPLY.monthly_cap) {
    throw new AAError(
      409,
      "monthly_cap",
      `Monthly limit is ${AUTO_APPLY.monthly_cap} applications; ${Math.max(0, AUTO_APPLY.monthly_cap - purchased)} left this month.`,
    );
  }

  const { data: batch, error } = await db
    .from("aa_batches")
    .insert({
      user_id: userId,
      pack_kind: input.pack_kind,
      pack_size: input.pack_size,
      price_paise: input.price_paise,
      currency: "INR",
      window_days: input.window_days,
      status: "pending_payment",
      credits_total: input.pack_size,
    })
    .select("*")
    .single();
  if (error) throw error;

  let order;
  try {
    order = await razorpay.createOrder({
      amountPaise: input.price_paise,
      currency: "INR",
      receipt: `aa_${String(batch.id).replace(/-/g, "").slice(0, 20)}`,
      notes: { kind: "autoapply", batch_id: batch.id, user_id: userId },
    });
  } catch (err) {
    await db.from("aa_batches").update({ status: "cancelled" }).eq("id", batch.id);
    throw new AAError(502, "order_failed", "Could not create the payment order.");
  }

  const { error: upErr } = await db.from("aa_batches").update({ razorpay_order_id: order.id }).eq("id", batch.id);
  if (upErr) throw upErr;

  return {
    order_id: order.id,
    amount: order.amount,
    currency: order.currency,
    key_id: razorpay.keyId(),
    batch_id: batch.id,
  };
}

/**
 * The single idempotent "paid" step. Safe to call any number of times, from
 * the verify route and from the webhook, in any order.
 */
export async function markBatchPaid({ db, batch, paymentId, now = new Date() }) {
  const purchasedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + AUTO_APPLY.credit_validity_days * DAY_MS).toISOString();

  const { data: won, error } = await db
    .from("aa_batches")
    .update({
      status: "paid",
      purchased_at: purchasedAt,
      expires_at: expiresAt,
      razorpay_payment_id: paymentId,
    })
    .eq("id", batch.id)
    // 'cancelled' too: a user who cancelled the pending order and then paid it
    // anyway still gets the credits (the money was taken).
    .in("status", ["pending_payment", "cancelled"])
    .is("purchased_at", null)
    .select("*");
  if (error) throw error;

  let current = won && won[0];
  if (!current) {
    const { data: again, error: rErr } = await db.from("aa_batches").select("*").eq("id", batch.id).maybeSingle();
    if (rErr) throw rErr;
    current = again;
  }
  if (!current || !current.purchased_at) {
    // e.g. the batch was cancelled before payment landed — surface for manual handling.
    console.warn(`[autoapply] payment ${paymentId} for batch ${batch.id} but batch is ${current && current.status}`);
    return current;
  }

  const { error: lErr } = await db.from("aa_credit_ledger").insert({
    user_id: current.user_id,
    batch_id: current.id,
    delta: current.credits_total,
    reason: "purchase",
    razorpay_payment_id: current.razorpay_payment_id || paymentId,
  });
  if (lErr && !isDup(lErr)) throw lErr;
  return current;
}

export async function verifyAutoApplyPayment({ db, razorpay, userId, body, now = new Date() }) {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    throw new AAError(400, "missing_fields", "razorpay_order_id, razorpay_payment_id and razorpay_signature are required.");
  }
  if (!razorpay.isEnabled()) throw new AAError(503, "checkout_unconfigured", "Payments are not configured.");
  const ok = razorpay.verifyPaymentSignature({
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    signature: razorpay_signature,
  });
  if (!ok) throw new AAError(400, "signature_mismatch", "Payment signature did not verify.");

  const { data: batch, error } = await db
    .from("aa_batches")
    .select("*")
    .eq("razorpay_order_id", razorpay_order_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!batch) throw new AAError(404, "not_found", "No AutoApply order matches this payment.");

  // Already paid with this payment: idempotent replay.
  if (batch.purchased_at && batch.razorpay_payment_id === razorpay_payment_id) {
    return markBatchPaid({ db, batch, paymentId: razorpay_payment_id, now });
  }

  const order = await razorpay.fetchOrder(razorpay_order_id);
  if (order) {
    const n = order.notes || {};
    if (
      Number(order.amount) !== Number(batch.price_paise) ||
      String(n.kind || "") !== "autoapply" ||
      String(n.batch_id || "") !== String(batch.id) ||
      String(n.user_id || "") !== String(userId)
    ) {
      throw new AAError(400, "order_mismatch", "The payment order does not match this AutoApply order.");
    }
  }
  return markBatchPaid({ db, batch, paymentId: razorpay_payment_id, now });
}

/**
 * Razorpay webhook branch. Returns null when the event is not an AutoApply
 * payment (the caller continues with its own handling), else a JSON body.
 */
export async function handleAutoApplyWebhook({ db, body, now = new Date() }) {
  const event = String((body && body.event) || "");
  if (event !== "payment.captured" && event !== "order.paid") return null;
  const payment = body?.payload?.payment?.entity || null;
  const order = body?.payload?.order?.entity || null;
  const orderId = (payment && payment.order_id) || (order && order.id);
  const notes = { ...((order && order.notes) || {}), ...((payment && payment.notes) || {}) };
  if (!orderId) return null;
  const { data: batch, error } = await db.from("aa_batches").select("*").eq("razorpay_order_id", orderId).maybeSingle();
  if (error) {
    // payment.captured often carries no order notes, so the lookup runs for plan payments too. An AutoApply DB
    // problem must never break the existing subscription webhook: only surface it for our own orders.
    if (notes.kind === "autoapply") throw error;
    console.warn(`[autoapply] webhook lookup failed, passing through: ${error.message || error}`);
    return null;
  }
  if (!batch) {
    if (notes.kind === "autoapply") {
      console.warn(`[autoapply] webhook ${event}: no batch for order ${orderId}`);
      return { ok: true, note: "autoapply: unknown order" };
    }
    return null; // not ours — let the plan-order handler look at it
  }
  const paymentId = payment && payment.id;
  if (!paymentId) {
    // order.paid without the payment entity: nothing to record yet; payment.captured carries it.
    return { ok: true, note: "autoapply: waiting for payment entity" };
  }
  const paid = Number(payment.amount);
  if (paid !== Number(batch.price_paise)) {
    console.warn(`[autoapply] webhook amount mismatch for batch ${batch.id}: ${paid} != ${batch.price_paise}`);
    return { ok: true, note: "autoapply: amount mismatch" };
  }
  const b = await markBatchPaid({ db, batch, paymentId, now });
  return { ok: true, autoapply: true, batch_id: batch.id, status: b && b.status };
}

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
import { couponPackPrice, normCouponCode, redeemCoupon, releaseCoupon } from "../coupons.js";

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
  if (![50, 100].includes(size)) throw new AAError(400, "invalid_input", "pack_size must be 50 or 100.");
  const wd = window_days === undefined || window_days === null ? AUTO_APPLY.window_days_default : Number(window_days);
  if (!Number.isInteger(wd) || wd < 1 || wd > AUTO_APPLY.window_days_max) {
    throw new AAError(400, "invalid_input", `window_days must be an integer 1..${AUTO_APPLY.window_days_max}.`);
  }
  const price = packPrice(pack_kind, size);
  if (!price) throw new AAError(400, "invalid_input", "Pack price is not configured.");
  return { pack_kind, pack_size: size, window_days: wd, price_paise: price };
}

async function couponOrThrow(db, args, packSize) {
  let c;
  try {
    c = await redeemCoupon(db, args);
  } catch (err) {
    if (err && err.code && String(err.code).startsWith("coupon_")) throw new AAError(400, err.code, err.message);
    throw err;
  }
  if (packSize && c && c.maxPackSize && Number(packSize) > Number(c.maxPackSize)) {
    // a redemption already taken (non-dry) is given back
    if (c.redemptionId) await releaseCoupon(db, c.redemptionId);
    throw new AAError(400, "coupon_not_applicable", `This coupon covers packs of up to ${c.maxPackSize} applications.`);
  }
  return c;
}

/** Price a pack with an optional coupon (no redemption). */
export async function quoteAutoApplyCoupon({ db, userId, body }) {
  const input = validateOrderInput(body);
  const code = normCouponCode(body && body.coupon_code);
  if (!code) throw new AAError(400, "coupon_invalid", "Enter a coupon code.");
  const c = await couponOrThrow(db, { code, userId, target: "autoapply", dry: true }, input.pack_size);
  return { coupon_code: code, kind: c.kind, list_price_paise: input.price_paise, price_paise: couponPackPrice(c.kind, input.pack_size, input.price_paise) };
}

export async function createAutoApplyOrder({ db, razorpay, getUserPlan, userId, body, now = new Date() }) {
  const input = validateOrderInput(body);
  let code = "";
  try {
    code = normCouponCode(body && body.coupon_code);
  } catch (err) {
    throw new AAError(400, err.code, err.message);
  }
  const peek = code ? await couponOrThrow(db, { code, userId, target: "autoapply", dry: true }, input.pack_size) : null;
  const price = peek ? couponPackPrice(peek.kind, input.pack_size, input.price_paise) : input.price_paise;
  const plan = await getUserPlan(userId);
  // a free_all coupon covers the plan requirement too ("all services free")
  if (!isEligiblePlan(plan) && !(peek && peek.kind === "free_all")) {
    throw new AAError(403, "not_eligible", "AutoApply needs an active Pro or Max plan.");
  }
  if (price > 0 && !razorpay.isEnabled()) throw new AAError(503, "checkout_unconfigured", "Payments are not configured.");

  const { data: prof, error: pErr } = await db.from("aa_profiles").select("consent_at").eq("user_id", userId).maybeSingle();
  if (pErr) throw pErr;
  if (!(prof && prof.consent_at)) {
    throw new AAError(403, "consent_required", "Accept the AutoApply terms (Setup, first step) before buying a pack.");
  }

  // pending orders from the last 30 min count too: two checkouts opened side by side cannot both pass the cap
  const purchased = await monthPurchased(db, userId, now, { includePending: true });
  if (purchased + input.pack_size > AUTO_APPLY.monthly_cap) {
    throw new AAError(
      409,
      "monthly_cap",
      `Monthly limit is ${AUTO_APPLY.monthly_cap} applications; ${Math.max(0, AUTO_APPLY.monthly_cap - purchased)} left this month.`,
    );
  }

  // A free pack (price 0) redeems the coupon now. A paid coupon pack (per_job_rupee) only stores the code: the
  // coupon is redeemed when the payment is captured (markBatchPaid), so an abandoned checkout never uses it up
  // and the global / per-user limits are enforced under the redeem_coupon row lock at capture time.
  const redeemed = code && price === 0 ? await couponOrThrow(db, { code, userId, target: "autoapply" }, input.pack_size) : null;
  const row = {
    user_id: userId,
    pack_kind: input.pack_kind,
    pack_size: input.pack_size,
    price_paise: price,
    currency: "INR",
    window_days: input.window_days,
    status: "pending_payment",
    credits_total: input.pack_size,
  };
  if (redeemed) Object.assign(row, { coupon_code: code, coupon_redemption_id: redeemed.redemptionId });
  else if (code) row.coupon_code = code;
  const { data: batch, error } = await db.from("aa_batches").insert(row).select("*").single();
  if (error) {
    if (redeemed) await releaseCoupon(db, redeemed.redemptionId);
    throw error;
  }
  if (redeemed) {
    await db.from("coupon_redemptions").update({ batch_id: batch.id }).eq("id", redeemed.redemptionId);
  }

  if (price === 0) {
    // free pack: no Razorpay order, credited now (the synthetic payment id keeps the paid step idempotent)
    const paid = await markBatchPaid({ db, batch, paymentId: `coupon_${redeemed.redemptionId}`, now });
    return { free: true, batch_id: batch.id, batch: paid, amount: 0, currency: "INR" };
  }

  let order;
  try {
    order = await razorpay.createOrder({
      amountPaise: price,
      currency: "INR",
      receipt: `aa_${String(batch.id).replace(/-/g, "").slice(0, 20)}`,
      notes: { kind: "autoapply", batch_id: batch.id, user_id: userId },
    });
  } catch (err) {
    await db.from("aa_batches").update({ status: "cancelled" }).eq("id", batch.id);
    if (redeemed) await releaseCoupon(db, redeemed.redemptionId);
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

// The ledger 'note' column comes with sql/27; until it is applied the row is written without it.
const isMissingNote = (err) => !!err && (["PGRST204", "42703"].includes(err.code) || /\bnote\b/i.test(String(err.message || "")));

async function insertPurchaseLedger(db, batch, paymentId, note) {
  const row = {
    user_id: batch.user_id,
    batch_id: batch.id,
    delta: batch.credits_total,
    reason: "purchase",
    razorpay_payment_id: batch.razorpay_payment_id || paymentId,
  };
  if (note) row.note = note;
  let { error } = await db.from("aa_credit_ledger").insert(row);
  if (error && note && isMissingNote(error)) {
    const { note: _n, ...plain } = row;
    ({ error } = await db.from("aa_credit_ledger").insert(plain));
  }
  if (error && !isDup(error)) throw error;
}

export const LATE_PAYMENT_NOTE = "late_payment_auto_refund";
export const COUPON_UNAVAILABLE_NOTE = "coupon_unavailable_auto_refund";
export const CAP_OVERFLOW_NOTE = "monthly_cap_auto_refund";

/**
 * The single idempotent "paid" step. Safe to call any number of times, from the verify route and from the
 * webhook, in any order. A captured payment is never dropped:
 *  • pending_payment (unpaid)  -> 'paid', unless it would break the monthly cap -> 'refund_due' (full refund);
 *  • cancelled (unpaid, e.g. the user cancelled or the order expired before the payment landed)
 *                              -> 'refund_due' with purchased_at + payment id, refunded in full by the refunds cron.
 * In both refund cases the ledger gets the 'purchase' row (+credits) with a note, and the cron's 'refund' row
 * (-credits) balances it.
 */
export async function markBatchPaid({ db, batch, paymentId, now = new Date() }) {
  const purchasedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + AUTO_APPLY.credit_validity_days * DAY_MS).toISOString();

  const { data: fresh, error: fErr } = await db.from("aa_batches").select("*").eq("id", batch.id).maybeSingle();
  if (fErr) throw fErr;
  let current = fresh || batch;
  let note = null;

  if (current && !current.purchased_at) {
    let next = null;
    if (current.status === "pending_payment") {
      const purchased = await monthPurchased(db, current.user_id, now, { excludeBatchId: current.id });
      if (purchased + Number(current.credits_total || 0) > AUTO_APPLY.monthly_cap) {
        next = "refund_due";
        note = CAP_OVERFLOW_NOTE;
      } else next = "paid";
    } else if (current.status === "cancelled") {
      next = "refund_due";
      note = LATE_PAYMENT_NOTE;
    }
    // paid coupon pack: redeem the coupon now that the money is in. If it is no longer available (used up by
    // other captures, or this user's limit reached), the payment is refunded in full instead of activated.
    let redemption = null;
    if (next === "paid" && current.coupon_code && !current.coupon_redemption_id && Number(current.price_paise) > 0) {
      try {
        redemption = await redeemCoupon(db, { code: current.coupon_code, userId: current.user_id, target: "autoapply" });
      } catch (err) {
        if (!(err && String(err.code || "").startsWith("coupon_"))) throw err;
        next = "refund_due";
        note = COUPON_UNAVAILABLE_NOTE;
      }
    }
    if (next) {
      const patch = { status: next, purchased_at: purchasedAt, expires_at: expiresAt, razorpay_payment_id: paymentId };
      if (redemption) patch.coupon_redemption_id = redemption.redemptionId;
      // payment-safety refund (money that never bought a running batch): marked explicitly so the refunds cron
      // (refundAllowed) and the sql/45 guard let it through; any other refund needs an admin.
      if (next === "refund_due" && note) patch.refund_reason = note;
      const { data: won, error } = await db
        .from("aa_batches")
        .update(patch)
        .eq("id", current.id)
        .eq("status", current.status)
        .is("purchased_at", null)
        .select("*");
      if (error) {
        if (redemption) await releaseCoupon(db, redemption.redemptionId);
        throw error;
      }
      if (won && won[0]) {
        current = won[0];
        if (redemption) await db.from("coupon_redemptions").update({ batch_id: current.id }).eq("id", redemption.redemptionId);
        if (note) console.warn(`[autoapply] payment ${paymentId} for batch ${current.id}: ${note} (refund_due)`);
      } else {
        // another caller (verify vs webhook) won the flip: give back the redemption this call took
        if (redemption) await releaseCoupon(db, redemption.redemptionId);
        note = null;
        const { data: again, error: rErr } = await db.from("aa_batches").select("*").eq("id", batch.id).maybeSingle();
        if (rErr) throw rErr;
        current = again;
      }
    }
  }
  if (!current || !current.purchased_at) {
    // unknown batch state (should not happen: every unpaid status is handled above) — surface for manual handling
    console.error(`[autoapply] payment ${paymentId} for batch ${batch.id} not recorded: batch is ${current && current.status}`);
    return current;
  }
  if (current.razorpay_payment_id && paymentId && current.razorpay_payment_id !== paymentId) {
    console.error(`[autoapply] second payment ${paymentId} for batch ${current.id} (paid with ${current.razorpay_payment_id}); refund it by hand`);
  }

  await insertPurchaseLedger(db, current, paymentId, note);
  return current;
}

export const PENDING_ORDER_TTL_MS = DAY_MS;

/** Cron: pending_payment orders older than 24 h -> 'cancelled' (a payment that still lands is auto-refunded). */
export async function expirePendingOrders({ db, now = new Date(), olderThanMs = PENDING_ORDER_TTL_MS } = {}) {
  const { data, error } = await db
    .from("aa_batches")
    .update({ status: "cancelled" })
    .eq("status", "pending_payment")
    .is("purchased_at", null)
    .lt("created_at", new Date(now.getTime() - olderThanMs).toISOString())
    .select("id, coupon_redemption_id");
  if (error) throw error;
  // an unpaid coupon order gives the coupon back
  for (const b of data || []) if (b.coupon_redemption_id) await releaseCoupon(db, b.coupon_redemption_id);
  return { expired: (data || []).length };
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

  // Fail closed: without the order from Razorpay the amount / notes cannot be checked. The client retries
  // (503), and the signed payment.captured webhook still records the payment meanwhile.
  const order = await razorpay.fetchOrder(razorpay_order_id);
  if (!order) throw new AAError(503, "order_unverified", "Could not confirm the order with Razorpay yet. Please retry in a minute; your payment is safe.");
  {
    const n = order.notes || {};
    if (
      String(order.status || "") !== "paid" ||
      Number(order.amount) !== Number(batch.price_paise) ||
      Number(order.amount_paid ?? order.amount) !== Number(batch.price_paise) ||
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
 * A payment that needs a human (sql/45 aa_payment_reviews): idempotent per (payment, kind). Never throws: a
 * failure to record is logged loudly, the webhook still answers 200 so Razorpay does not retry forever.
 */
export async function recordPaymentReview(db, row) {
  try {
    const { error } = await db.from("aa_payment_reviews").upsert(row, { onConflict: "razorpay_payment_id,kind", ignoreDuplicates: true });
    if (error) throw error;
    return true;
  } catch (e) {
    console.error(`[autoapply] PAYMENT REVIEW NOT RECORDED (${row.kind}) batch ${row.batch_id} payment ${row.razorpay_payment_id}:`, (e && e.message) || String(e));
    return false;
  }
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
    await recordPaymentReview(db, {
      kind: "amount_mismatch",
      batch_id: batch.id,
      user_id: batch.user_id || null,
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      expected_paise: Number(batch.price_paise) || 0,
      paid_paise: Number.isFinite(paid) ? paid : null,
      detail: { event, currency: payment.currency || null, status: payment.status || null },
    });
    return { ok: true, note: "autoapply: amount mismatch (recorded for review)" };
  }
  const b = await markBatchPaid({ db, batch, paymentId, now });
  return { ok: true, autoapply: true, batch_id: batch.id, status: b && b.status };
}

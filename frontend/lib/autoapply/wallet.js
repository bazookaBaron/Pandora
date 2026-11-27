/**
 * AutoApply wallet (sql/55_autoapply_wallet.sql): top-ups through one-time Razorpay orders, and starting a batch
 * (an atomic hold of size x product rate). Money only moves through the SECURITY DEFINER functions; this file
 * validates, talks to Razorpay and calls them.
 *
 *   top-up:  POST /wallet/topup -> order {notes.kind:'wallet_topup', user_id}; the credit happens exactly once from
 *            whichever arrives first (POST /wallet/topup/verify or the order.paid webhook): processed_payments
 *            claim + the unique order / payment keys of aa_wallet_ledger. The amount credited is Razorpay's
 *            amount_paid of a 'paid' order, never a client value.
 *   start:   POST /batches {size, window_days, must_companies} -> aa_wallet_start_batch (balance >= one application
 *            at the top rate, then the batch in 'shortlisting'; no money moves). Each application is reserved by
 *            the worker at claim, captured when applied, released otherwise; an empty wallet parks the batch in
 *            'waiting_funds' and a top-up resumes it (aa_wallet_topup).
 */
import { AUTO_APPLY } from "../../config/tiers.js";
import { isEligiblePlan, monthPurchased } from "./limits.js";
import { AAError } from "./orders.js";

export const TOPUP_KIND = "wallet_topup";
const W = () => AUTO_APPLY.wallet;
const isDup = (err) => err && (err.code === "23505" || /duplicate key/i.test(String(err.message || "")));

export function walletRates() {
  const r = W().rate_paise;
  return { product: r.product, service: r.service };
}

/** Balance needed to start a batch: one application at the top rate (applications are reserved one by one). */
export function minStartBalance() {
  return W().rate_paise.product;
}

export function validateTopupAmount(amountPaise) {
  const n = Number(amountPaise);
  const { min_topup_paise: min, max_topup_paise: max } = W();
  if (!Number.isInteger(n) || n % 100 !== 0) throw new AAError(400, "invalid_input", "Enter a whole number of rupees.");
  if (n < min) throw new AAError(400, "amount_too_low", `The minimum top-up is ₹${min / 100}.`);
  if (n > max) throw new AAError(400, "amount_too_high", `The maximum top-up is ₹${max / 100}.`);
  return n;
}

export function validateStartInput(body) {
  const b = body || {};
  const size = Number(b.size);
  if (!W().batch_sizes.includes(size)) throw new AAError(400, "invalid_input", `size must be one of ${W().batch_sizes.join(", ")}.`);
  const wd = b.window_days === undefined || b.window_days === null ? AUTO_APPLY.window_days_default : Number(b.window_days);
  if (!Number.isInteger(wd) || wd < 1 || wd > AUTO_APPLY.window_days_max) {
    throw new AAError(400, "invalid_input", `window_days must be an integer 1..${AUTO_APPLY.window_days_max}.`);
  }
  return { size, window_days: wd };
}

export async function getWallet(db, userId) {
  const { data, error } = await db.from("aa_wallets").select("balance_paise, held_paise").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  const w = data || {};
  return { balance_paise: Number(w.balance_paise) || 0, held_paise: Number(w.held_paise) || 0 };
}

export async function walletSummary(db, userId) {
  const [w, led] = await Promise.all([
    getWallet(db, userId),
    db
      .from("aa_wallet_ledger")
      .select("id, kind, delta_paise, held_delta_paise, batch_id, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  if (led.error) throw led.error;
  return { ...w, rates: walletRates(), min_start_paise: minStartBalance(), min_topup_paise: W().min_topup_paise, max_topup_paise: W().max_topup_paise, presets_paise: W().topup_presets_paise, recent: led.data || [] };
}

export async function createTopupOrder({ db: _db, razorpay, userId, body }) {
  const amount = validateTopupAmount(body && body.amount_paise);
  if (!razorpay.isEnabled()) throw new AAError(503, "checkout_unconfigured", "Payments are not configured.");
  let order;
  try {
    order = await razorpay.createOrder({
      amountPaise: amount,
      currency: "INR",
      receipt: `wt_${String(userId).replace(/-/g, "").slice(0, 16)}_${Date.now().toString(36)}`,
      notes: { kind: TOPUP_KIND, user_id: userId },
    });
  } catch {
    throw new AAError(502, "order_failed", "Could not create the payment order.");
  }
  return { order_id: order.id, amount: order.amount, currency: order.currency, key_id: razorpay.keyId() };
}

/**
 * Credit one captured top-up exactly once. `order` is Razorpay's own entity (verified paid, amount_paid, notes).
 * -> { credited, duplicate, balance_paise }
 */
export async function creditTopup({ db, order, paymentId, userId, source }) {
  const amount = Number(order.amount_paid);
  const claim = await db.from("processed_payments").insert({
    payment_id: paymentId,
    order_id: order.id,
    user_id: userId,
    plan: TOPUP_KIND,
    billing_period: "once",
    amount,
    currency: order.currency || "INR",
    source,
  });
  const claimedHere = !claim.error;
  if (claim.error && !isDup(claim.error)) throw claim.error;
  // The ledger's unique order / payment keys make the credit idempotent even when the claim row already exists
  // (a crash between claim and credit is healed by the retry: the function credits once, whoever calls).
  const { data, error } = await db.rpc("aa_wallet_topup", {
    p_user: userId,
    p_order: order.id,
    p_payment: paymentId,
    p_amount: amount,
    p_note: source,
  });
  if (error) {
    if (claimedHere) await db.from("processed_payments").delete().eq("payment_id", paymentId);
    throw error;
  }
  const r = data || {};
  return { credited: !!r.credited, duplicate: !!r.duplicate, balance_paise: Number(r.balance_paise) || 0, resumed: Number(r.resumed) || 0 };
}

function orderIsPaidTopup(order, userId) {
  const n = (order && order.notes) || {};
  return (
    !!order &&
    String(n.kind || "") === TOPUP_KIND &&
    (userId === undefined || String(n.user_id || "") === String(userId)) &&
    order.status === "paid" &&
    Number.isInteger(Number(order.amount_paid)) &&
    Number(order.amount_paid) > 0 &&
    Number(order.amount_paid) === Number(order.amount)
  );
}

export async function verifyTopup({ db, razorpay, userId, body }) {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    throw new AAError(400, "missing_fields", "razorpay_order_id, razorpay_payment_id and razorpay_signature are required.");
  }
  if (!razorpay.isEnabled()) throw new AAError(503, "checkout_unconfigured", "Payments are not configured.");
  if (!razorpay.verifyPaymentSignature({ orderId: razorpay_order_id, paymentId: razorpay_payment_id, signature: razorpay_signature })) {
    throw new AAError(400, "signature_mismatch", "Payment signature did not verify.");
  }
  const order = await razorpay.fetchOrder(razorpay_order_id);
  if (!order) throw new AAError(503, "order_unverified", "Could not confirm the payment with Razorpay yet. Retry in a minute; your payment is safe.");
  const n = order.notes || {};
  if (String(n.kind || "") !== TOPUP_KIND || String(n.user_id || "") !== String(userId)) {
    throw new AAError(400, "order_mismatch", "This payment is not a wallet top-up for your account.");
  }
  if (!orderIsPaidTopup(order, userId)) {
    throw new AAError(409, "not_paid", "Razorpay has not marked this order as fully paid yet. Retry in a minute.");
  }
  const r = await creditTopup({ db, order, paymentId: razorpay_payment_id, userId, source: "verify" });
  return { ...r, wallet: await getWallet(db, userId) };
}

/**
 * Razorpay webhook branch: order.paid with notes.kind = 'wallet_topup'. Returns null when it is not ours.
 */
export async function handleWalletWebhook({ db, body }) {
  if (String((body && body.event) || "") !== "order.paid") return null;
  const order = body?.payload?.order?.entity || null;
  const n = (order && order.notes) || {};
  if (String(n.kind || "") !== TOPUP_KIND) return null;
  const payment = body?.payload?.payment?.entity || null;
  const userId = String(n.user_id || "");
  if (!userId || !payment || !payment.id) return { ok: true, note: "wallet: waiting for payment entity" };
  if (!orderIsPaidTopup(order)) {
    console.warn(`[wallet] order.paid for ${order.id} is not a fully paid top-up (status ${order.status}, ${order.amount_paid}/${order.amount})`);
    return { ok: true, note: "wallet: order not fully paid" };
  }
  const r = await creditTopup({ db, order, paymentId: payment.id, userId, source: "webhook" });
  return { ok: true, wallet: true, credited: r.credited, duplicate: r.duplicate };
}

/**
 * Start a batch from the wallet. Plan check stays the existing getUserPlan rule (swap to requiresActivePlan once
 * feat/subscriptions lands). -> { batch, wallet }
 */
export async function startBatch({ db, getUserPlan, userId, body, must = [], now = new Date() }) {
  const input = validateStartInput(body);
  const plan = await getUserPlan(userId);
  if (!isEligiblePlan(plan)) throw new AAError(403, "not_eligible", "AutoApply needs an active Pro or Max plan.");

  const { data: prof, error: pErr } = await db.from("aa_profiles").select("consent_at").eq("user_id", userId).maybeSingle();
  if (pErr) throw pErr;
  if (!(prof && prof.consent_at)) throw new AAError(403, "consent_required", "Accept the AutoApply terms (Setup, first step) before starting a batch.");

  const purchased = await monthPurchased(db, userId, now);
  if (purchased + input.size > AUTO_APPLY.monthly_cap) {
    throw new AAError(409, "monthly_cap", `Monthly limit is ${AUTO_APPLY.monthly_cap} applications; ${Math.max(0, AUTO_APPLY.monthly_cap - purchased)} left this month.`);
  }

  const rates = walletRates();
  const { data, error } = await db.rpc("aa_wallet_start_batch", {
    p_user: userId,
    p_size: input.size,
    p_rate_product: rates.product,
    p_rate_service: rates.service,
    p_window_days: input.window_days,
    p_must: must,
    p_valid_days: W().batch_valid_days,
  });
  if (error) throw error;
  const r = data || {};
  if (!r.ok) {
    if (r.reason === "insufficient_balance") {
      const e = new AAError(
        402,
        "insufficient_balance",
        `Add at least ₹${Math.ceil(r.shortfall_paise / 100)} to your wallet to start a batch.`,
      );
      e.extra = { balance_paise: r.balance_paise, needed_paise: r.needed_paise, shortfall_paise: r.shortfall_paise };
      throw e;
    }
    throw new AAError(400, "invalid_input", "Could not start the batch.");
  }
  const { data: batch, error: bErr } = await db.from("aa_batches").select("*").eq("id", r.batch_id).maybeSingle();
  if (bErr) throw bErr;
  return { batch, wallet: await getWallet(db, userId) };
}

/** Remaining credits and a pre-filled next batch for a finished batch ("Start again with remaining"). */
export function retriggerFor(batch) {
  const total = Number(batch && batch.credits_total) || 0;
  const used = Number(batch && batch.credits_used) || 0;
  const remaining = Math.max(0, total - used);
  if (!remaining || !["finished_partial", "completed", "cancelled", "expired"].includes(batch && batch.status)) return null;
  const sizes = W().batch_sizes;
  const size = sizes.find((s) => s >= remaining) || sizes[sizes.length - 1];
  return {
    remaining,
    size,
    window_days: Number(batch.window_days) || AUTO_APPLY.window_days_default,
    must_companies: Array.isArray(batch.must_companies) ? batch.must_companies : [],
  };
}

/** Push body for a batch that ran out of wallet money (once per entry into waiting_funds). */
export function fundsPushPayload(left) {
  return {
    title: "Wallet empty",
    body: `Add money to continue: ${left} application${left === 1 ? "" : "s"} left in your batch. It resumes by itself after you top up.`,
    url: "/autoapply",
    tag: "aa-wallet-empty",
  };
}

/**
 * Cron: for each batch in 'waiting_funds' that was not announced yet, claim aa_batches.funds_notified_at
 * (conditional update, multi-replica safe) and send ONE push (same channel and opt-out as the needs-you push).
 */
export async function notifyWaitingFunds({ db, send, now = new Date() }) {
  const { data, error } = await db
    .from("aa_batches")
    .select("id, user_id, credits_total, credits_used")
    .eq("status", "waiting_funds")
    .is("funds_notified_at", null)
    .limit(500);
  if (error) throw error;
  let sent = 0;
  for (const b of data || []) {
    const { data: won, error: uErr } = await db
      .from("aa_batches")
      .update({ funds_notified_at: now.toISOString() })
      .eq("id", b.id)
      .is("funds_notified_at", null)
      .select("id");
    if (uErr) throw uErr;
    if (!won || !won[0]) continue;
    const { data: prof } = await db.from("aa_profiles").select("alert_prefs").eq("user_id", b.user_id).maybeSingle();
    const prefs = prof && prof.alert_prefs && typeof prof.alert_prefs === "object" ? prof.alert_prefs : {};
    const left = Math.max(0, (Number(b.credits_total) || 0) - (Number(b.credits_used) || 0));
    await send({ db, userId: b.user_id, payload: fundsPushPayload(left), prefs: { push: prefs.push !== false } });
    sent++;
  }
  return { sent };
}

/**
 * Idempotent grant helpers for one-time Razorpay payments (sql/30).
 *
 * claimPayment() inserts a processed_payments row. The UNIQUE constraints on
 * payment_id and order_id make the claim atomic: the first of {browser verify,
 * order.paid webhook} wins and grants the term; the other sees `duplicate` and
 * must NOT extend the period again.
 */
import { supabaseAdmin } from "./supabaseAdmin.js";

/**
 * New period end for a purchase: extends from the later of `now` and the
 * user's existing end when they are renewing the SAME plan; a different plan
 * (upgrade/downgrade) starts a fresh term from now.
 */
export function computePeriodEnd({ now = Date.now(), termDays, existing, plan }) {
  let base = now;
  if (
    existing &&
    existing.plan === plan &&
    existing.status === "active" &&
    existing.current_period_end
  ) {
    const end = new Date(existing.current_period_end).getTime();
    if (!Number.isNaN(end) && end > base) base = end;
  }
  return new Date(base + termDays * 86400000);
}

/**
 * @returns {Promise<{ claimed: true, id: string } | { claimed: false, duplicate: true }>}
 * Throws on any DB error other than a unique violation (callers fail closed).
 */
export async function claimPayment(row) {
  const { data, error } = await supabaseAdmin
    .from("processed_payments")
    .insert(row)
    .select("id")
    .maybeSingle();
  if (!error) return { claimed: true, id: data && data.id };
  if (error.code === "23505" || /duplicate key|unique/i.test(String(error.message))) {
    return { claimed: false, duplicate: true };
  }
  throw error;
}

/** Release a claim after a failed grant so the payment can be retried. */
export async function releasePayment(paymentId) {
  await supabaseAdmin.from("processed_payments").delete().eq("payment_id", paymentId);
}

export async function recordPaymentPeriodEnd(paymentId, endISO) {
  await supabaseAdmin
    .from("processed_payments")
    .update({ period_end: endISO })
    .eq("payment_id", paymentId);
}

/**
 * Record a webhook event id. @returns {Promise<boolean>} true if NEW, false if
 * it was already processed. Throws on DB errors (webhook returns 500 -> retry).
 */
export async function claimWebhookEvent(eventId, eventType) {
  if (!eventId) return true; // no id to dedupe on
  const { error } = await supabaseAdmin
    .from("processed_webhook_events")
    .insert({ event_id: eventId, event_type: eventType || null });
  if (!error) return true;
  if (error.code === "23505" || /duplicate key|unique/i.test(String(error.message))) return false;
  throw error;
}

export async function releaseWebhookEvent(eventId) {
  if (!eventId) return;
  await supabaseAdmin.from("processed_webhook_events").delete().eq("event_id", eventId);
}

/**
 * AutoApply refunds cron: batches in 'refund_due' -> Razorpay refund of
 * price_paise * remaining / credits_total -> ledger 'refund' (-remaining) ->
 * 'refunded'.
 *
 * Safety:
 *  • a batch with tasks still in flight (claimed/running/waiting_code/
 *    submitting) is skipped until they finish, so a late 'applied' can't spend
 *    a credit that was already refunded;
 *  • before refunding, existing refunds on the payment are listed and one whose
 *    notes.batch_id matches is reused (a crash between Razorpay and our DB
 *    write never double-refunds);
 *  • the final status flip is conditional on status = 'refund_due'.
 */
const IN_FLIGHT = ["claimed", "running", "waiting_code", "submitting"];
const MIN_REFUND_PAISE = 100;

export function refundAmount(batch) {
  const total = Number(batch.credits_total) || 0;
  const used = Math.min(total, Math.max(0, Number(batch.credits_used) || 0));
  const remaining = total - used;
  const paise = total > 0 ? Math.floor((Number(batch.price_paise) * remaining) / total) : 0;
  return { remaining, paise };
}

async function refundOne({ db, razorpay, batch }) {
  const { count: inflight, error: cErr } = await db
    .from("aa_tasks")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batch.id)
    .in("status", IN_FLIGHT);
  if (cErr) throw cErr;
  if (inflight > 0) return { batch_id: batch.id, skipped: "in_flight" };

  const { remaining, paise } = refundAmount(batch);
  let refundId = null;
  let refunded = 0;

  if (remaining > 0 && paise >= MIN_REFUND_PAISE) {
    if (!batch.razorpay_payment_id) return { batch_id: batch.id, skipped: "no_payment_id" };
    const existing = await razorpay.listRefunds(batch.razorpay_payment_id);
    if (existing === null) return { batch_id: batch.id, skipped: "list_failed" };
    const prior = existing.find((r) => r && r.notes && String(r.notes.batch_id) === String(batch.id));
    if (prior) {
      refundId = prior.id;
      refunded = Number(prior.amount) || paise;
    } else {
      const r = await razorpay.refundPayment(batch.razorpay_payment_id, {
        amountPaise: paise,
        notes: { kind: "autoapply", batch_id: batch.id, credits: String(remaining) },
        receipt: `aar_${String(batch.id).replace(/-/g, "").slice(0, 20)}`,
      });
      refundId = r && r.id;
      refunded = Number(r && r.amount) || paise;
    }
  }

  if (remaining > 0) {
    const { data: prev, error: pErr } = await db
      .from("aa_credit_ledger")
      .select("id")
      .eq("batch_id", batch.id)
      .eq("reason", "refund")
      .limit(1);
    if (pErr) throw pErr;
    if (!prev || prev.length === 0) {
      const { error: lErr } = await db.from("aa_credit_ledger").insert({
        user_id: batch.user_id,
        batch_id: batch.id,
        delta: -remaining,
        reason: "refund",
        razorpay_payment_id: batch.razorpay_payment_id || null,
      });
      if (lErr) throw lErr;
    }
  }

  const { error: uErr } = await db
    .from("aa_batches")
    .update({ status: "refunded", refund_paise: refunded, razorpay_refund_id: refundId })
    .eq("id", batch.id)
    .eq("status", "refund_due");
  if (uErr) throw uErr;
  return { batch_id: batch.id, refunded_paise: refunded, credits: remaining, refund_id: refundId };
}

let running = false;

/** Process up to `limit` refund_due batches. Never throws. */
export async function processRefunds({ db, razorpay, limit = 25 }) {
  if (running) return { busy: true };
  running = true;
  const results = [];
  try {
    if (!razorpay.isEnabled()) return { disabled: true };
    const { data: due, error } = await db
      .from("aa_batches")
      .select("*")
      .eq("status", "refund_due")
      .order("updated_at", { ascending: true })
      .limit(limit);
    if (error) throw error;
    for (const batch of due || []) {
      try {
        results.push(await refundOne({ db, razorpay, batch }));
      } catch (e) {
        console.error(`[autoapply/refunds] batch ${batch.id}:`, (e && e.message) || String(e));
        results.push({ batch_id: batch.id, error: true });
      }
    }
    if (results.length) console.log("[autoapply/refunds]", JSON.stringify(results));
    return { results };
  } catch (e) {
    console.error("[autoapply/refunds]", (e && e.message) || String(e));
    return { error: true, results };
  } finally {
    running = false;
  }
}

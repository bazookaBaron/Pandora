/**
 * AutoApply refunds cron: batches in 'refund_due' -> Razorpay refund of
 * price_paise * remaining / credits_total -> ledger 'refund' (-remaining) ->
 * 'refunded'.
 *
 * Safety:
 *  • multi-replica: node-cron runs in every API replica, so each batch is CLAIMED first with a conditional update
 *    refund_due -> 'refunding' (RETURNING the row); only the replica whose update returned the row works on it.
 *    A claim older than STALE_CLAIM_MS (replica died mid-refund) is re-claimed the same way;
 *  • a batch with tasks still in flight (claimed/running/waiting_code/submitting) is released back to
 *    'refund_due' until they finish, so a late 'applied' can't spend a credit that was already refunded;
 *  • credits_used is re-read AFTER the in-flight check (the claim's own RETURNING row), never taken from the
 *    candidate list, so a capture that landed meanwhile is not refunded;
 *  • before refunding, existing refunds on the payment are listed and one whose notes.batch_id matches is
 *    reused (a crash between Razorpay and our DB write never double-refunds);
 *  • a batch with nothing paid (no payment id / purchased_at) has nothing to refund: -> 'cancelled' instead of
 *    being retried every 15 minutes;
 *  • the final status flip is conditional on status = 'refunding'.
 */
const IN_FLIGHT = ["claimed", "running", "waiting_code", "submitting"];
const MIN_REFUND_PAISE = 100;
export const STALE_CLAIM_MS = 30 * 60 * 1000;

export function refundAmount(batch) {
  const total = Number(batch.credits_total) || 0;
  const used = Math.min(total, Math.max(0, Number(batch.credits_used) || 0));
  const remaining = total - used;
  const paise = total > 0 ? Math.floor((Number(batch.price_paise) * remaining) / total) : 0;
  return { remaining, paise };
}

/** Conditional claim; returns the claimed (fresh) row or null when another replica has it. */
async function claim(db, batch, now) {
  const fromStatus = batch.status === "refunding" ? "refunding" : "refund_due";
  let q = db.from("aa_batches").update({ status: "refunding" }).eq("id", batch.id).eq("status", fromStatus);
  if (fromStatus === "refunding") q = q.lt("updated_at", new Date(now.getTime() - STALE_CLAIM_MS).toISOString());
  const { data, error } = await q.select("*");
  if (error) throw error;
  return (data && data[0]) || null;
}

async function release(db, batchId, status = "refund_due", patch = {}) {
  const { error } = await db.from("aa_batches").update({ status, ...patch }).eq("id", batchId).eq("status", "refunding");
  if (error) throw error;
}

async function refundOne({ db, razorpay, batch: candidate, now }) {
  const claimed = await claim(db, candidate, now);
  if (!claimed) return { batch_id: candidate.id, skipped: "claimed_elsewhere" };
  try {
    const { count: inflight, error: cErr } = await db
      .from("aa_tasks")
      .select("id", { count: "exact", head: true })
      .eq("batch_id", claimed.id)
      .in("status", IN_FLIGHT);
    if (cErr) throw cErr;
    if (inflight > 0) {
      await release(db, claimed.id);
      return { batch_id: claimed.id, skipped: "in_flight" };
    }
    // re-read after the in-flight check: a capture may have landed between the claim and the check
    const { data: batch, error: bErr } = await db.from("aa_batches").select("*").eq("id", claimed.id).maybeSingle();
    if (bErr) throw bErr;
    if (!batch || batch.status !== "refunding") return { batch_id: claimed.id, skipped: "changed" };

    if (!batch.razorpay_payment_id || !batch.purchased_at) {
      // never paid: nothing to refund — out of the refund queue for good
      await release(db, batch.id, "cancelled");
      return { batch_id: batch.id, cancelled: "no_payment_id" };
    }

    const { remaining, paise } = refundAmount(batch);
    let refundId = null;
    let refunded = 0;

    if (remaining > 0 && paise >= MIN_REFUND_PAISE) {
      const existing = await razorpay.listRefunds(batch.razorpay_payment_id);
      if (existing === null) {
        await release(db, batch.id);
        return { batch_id: batch.id, skipped: "list_failed" };
      }
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

    await release(db, batch.id, "refunded", { refund_paise: refunded, razorpay_refund_id: refundId });
    return { batch_id: batch.id, refunded_paise: refunded, credits: remaining, refund_id: refundId };
  } catch (e) {
    // hand it back to the queue; the Razorpay refund (if one was made) is found again via listRefunds
    try { await release(db, claimed.id); } catch {}
    throw e;
  }
}

// Per-process overlap guard only (one pass at a time in this replica); cross-replica safety is the claim above.
let running = false;

/** Process up to `limit` refund_due (and stale 'refunding') batches. Never throws. */
export async function processRefunds({ db, razorpay, limit = 25, now = new Date() }) {
  if (running) return { busy: true };
  running = true;
  const results = [];
  try {
    if (!razorpay.isEnabled()) return { disabled: true };
    const { data: due, error } = await db
      .from("aa_batches")
      .select("id, status, updated_at")
      .eq("status", "refund_due")
      .order("updated_at", { ascending: true })
      .limit(limit);
    if (error) throw error;
    const { data: stale, error: sErr } = await db
      .from("aa_batches")
      .select("id, status, updated_at")
      .eq("status", "refunding")
      .lt("updated_at", new Date(now.getTime() - STALE_CLAIM_MS).toISOString())
      .order("updated_at", { ascending: true })
      .limit(limit);
    if (sErr) throw sErr;
    for (const batch of [...(due || []), ...(stale || [])]) {
      try {
        results.push(await refundOne({ db, razorpay, batch, now }));
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

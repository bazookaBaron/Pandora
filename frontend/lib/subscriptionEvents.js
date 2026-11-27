/**
 * Pure reducer for Razorpay subscription webhooks (no I/O, fully unit-tested).
 *
 * The webhook route (server.js) loads the stored subscriptions row BY
 * provider_subscription_id, calls reduceSubscriptionEvent(), and applies the
 * returned patch with `.update(patch).eq(user_id).eq(provider_subscription_id)`
 * - never an upsert - so a stale event for an old subscription can never
 * overwrite a newer one.
 *
 * Access rules produced here (enforced in lib/entitlements.js):
 *   subscription.activated / charged -> active, current_period_end = entity.current_end
 *   subscription.pending / payment.failed -> past_due + 3-day grace (grace_until)
 *   subscription.halted              -> halted: Free immediately
 *   subscription.cancelled / completed -> cancelled: access until current_period_end
 */

export const GRACE_MS = 3 * 24 * 60 * 60 * 1000;

export const HANDLED_EVENTS = new Set([
  "subscription.activated",
  "subscription.charged",
  "subscription.completed",
  "subscription.cancelled",
  "subscription.halted",
  "subscription.pending",
  "subscription.updated",
  "payment.failed",
]);

const PAID = new Set(["pro", "max"]);
const iso = (ms) => new Date(ms).toISOString();
const secToMs = (s) => (Number.isFinite(Number(s)) && Number(s) > 0 ? Number(s) * 1000 : null);
const tsMs = (v) => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * @param {object} a
 * @param {string} a.event                  Razorpay event name
 * @param {object|null} a.entity            payload.subscription.entity
 * @param {object|null} a.payment           payload.payment.entity
 * @param {string|null} a.subscriptionId    resolved subscription id (entity.id or payment's)
 * @param {object|null} a.stored            our subscriptions row for that subscription id
 * @param {number|null} a.eventCreatedMs
 * @param {number} [a.now]
 * @param {(planId:string)=>({plan,period,currency}|null)} [a.resolvePlan]
 * @returns {{action:'ignore', reason:string} | {action:'patch', patch:object, audit?:object, note?:string}}
 */
export function reduceSubscriptionEvent({
  event,
  entity = null,
  payment = null,
  subscriptionId = null,
  stored,
  eventCreatedMs = null,
  now = Date.now(),
  resolvePlan = () => null,
}) {
  if (!HANDLED_EVENTS.has(event)) return { action: "ignore", reason: "unhandled_event" };
  const subId = subscriptionId || (entity && entity.id) || null;
  if (!subId) return { action: "ignore", reason: "no_subscription_id" };
  if (!stored) return { action: "ignore", reason: "no_matching_row" };
  // The core safety rule: only the CURRENT subscription may touch the row.
  if (String(stored.provider_subscription_id || "") !== String(subId)) {
    return { action: "ignore", reason: "subscription_mismatch" };
  }
  const evMs = eventCreatedMs || now;
  const lastMs = tsMs(stored.last_event_at);
  if (eventCreatedMs && lastMs !== null && lastMs > eventCreatedMs) {
    return { action: "ignore", reason: "stale_event" };
  }

  const storedEnd = tsMs(stored.current_period_end);
  const storedLive = stored.status === "active" || stored.status === "past_due" || stored.status === "cancelled";
  const mapping = entity && entity.plan_id ? resolvePlan(entity.plan_id) : null;
  const entityEndMs = entity ? secToMs(entity.current_end) ?? secToMs(entity.charge_at) : null;

  const patch = {
    last_event_at: iso(Math.max(evMs, lastMs || 0)),
    updated_at: iso(now),
  };
  const applyIdentity = () => {
    if (entity && entity.customer_id) patch.provider_customer_id = entity.customer_id;
    if (entity && entity.plan_id) patch.provider_plan_id = entity.plan_id;
    if (mapping) {
      patch.plan = mapping.plan;
      patch.billing_period = mapping.period;
      patch.currency = mapping.currency;
      if (stored.pending_plan && stored.pending_plan === mapping.plan) patch.pending_plan = null;
    }
  };
  // Never move the paid-through date backwards on the same plan.
  const extendEnd = (candidateMs) => {
    if (candidateMs === null) return false;
    const samePlan = !patch.plan || patch.plan === stored.plan;
    patch.current_period_end = iso(samePlan && storedEnd !== null ? Math.max(storedEnd, candidateMs) : candidateMs);
    return true;
  };

  switch (event) {
    case "subscription.activated":
    case "subscription.charged": {
      patch.status = "active";
      patch.grace_until = null;
      if (event === "subscription.activated") patch.cancel_at_period_end = false;
      applyIdentity();
      const hadEnd = extendEnd(entityEndMs);
      const out = { action: "patch", patch };
      if (!hadEnd) out.note = "no_period_end_in_event";
      if (event === "subscription.charged" && payment && payment.id) {
        out.audit = {
          payment_id: String(payment.id),
          order_id: String(payment.order_id || `sub_${payment.id}`),
          user_id: stored.user_id,
          plan: patch.plan || stored.plan,
          billing_period: patch.billing_period || stored.billing_period || "monthly",
          amount: Number.isFinite(Number(payment.amount)) ? Number(payment.amount) : null,
          currency: payment.currency || patch.currency || stored.currency || null,
          source: "webhook",
          period_end: patch.current_period_end || null,
        };
      }
      return out;
    }

    case "subscription.updated": {
      // Plan changes scheduled for cycle end are applied by the charged event.
      if (entity && entity.has_scheduled_changes !== true) applyIdentity();
      extendEnd(entityEndMs);
      return { action: "patch", patch };
    }

    case "subscription.pending":
    case "payment.failed": {
      // Only a subscription that has paid before can lapse into grace. A failed
      // FIRST payment (row still 'created') must not grant or change anything.
      if (!PAID.has(stored.plan) || !storedLive || storedEnd === null) {
        return { action: "ignore", reason: "no_paid_period_to_protect" };
      }
      if (stored.status === "cancelled") return { action: "ignore", reason: "already_cancelled" };
      patch.status = "past_due";
      const priorGrace = tsMs(stored.grace_until);
      patch.grace_until = stored.status === "past_due" && priorGrace !== null ? iso(priorGrace) : iso(evMs + GRACE_MS);
      return { action: "patch", patch };
    }

    case "subscription.halted": {
      patch.status = "halted";
      patch.grace_until = null;
      return { action: "patch", patch };
    }

    case "subscription.cancelled":
    case "subscription.completed": {
      patch.status = "cancelled";
      patch.cancel_at_period_end = true;
      patch.grace_until = null;
      if (event === "subscription.cancelled" && !stored.cancelled_at) patch.cancelled_at = iso(evMs);
      // Access continues to the paid-through date we already hold.
      if (storedEnd === null && entityEndMs !== null) patch.current_period_end = iso(entityEndMs);
      return { action: "patch", patch };
    }

    default:
      return { action: "ignore", reason: "unhandled_event" };
  }
}

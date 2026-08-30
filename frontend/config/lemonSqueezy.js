/**
 * Lemon Squeezy configuration — SERVER ONLY, dormant-safe.
 *
 * Every value is read from the environment and every one is optional: with the
 * vars unset this module still imports cleanly and `isConfigured()` returns
 * false. Callers (server.js routes, services/lemonSqueezy.js) gate on that.
 *
 * Imported only by server.js / services — never bundled into the browser — so
 * reading `process.env` directly here is fine.
 */

const STORE_ID = process.env.LEMONSQUEEZY_STORE_ID || "";

const VARIANT_PRO_MONTHLY = process.env.LEMONSQUEEZY_VARIANT_PRO_MONTHLY;
const VARIANT_PRO_YEARLY = process.env.LEMONSQUEEZY_VARIANT_PRO_YEARLY;
const VARIANT_MAX_MONTHLY = process.env.LEMONSQUEEZY_VARIANT_MAX_MONTHLY;
const VARIANT_MAX_YEARLY = process.env.LEMONSQUEEZY_VARIANT_MAX_YEARLY;

function present(v) {
  return v != null && String(v).trim() !== "";
}

/**
 * { [variantId]: { plan, billing_period } } — built from whichever of the four
 * variant env vars are set. Undefined ones are skipped.
 * @type {Record<string, { plan: "pro"|"max", billing_period: "monthly"|"yearly" }>}
 */
export const VARIANT_TO_PLAN = (() => {
  const pairs = [
    [VARIANT_PRO_MONTHLY, { plan: "pro", billing_period: "monthly" }],
    [VARIANT_PRO_YEARLY, { plan: "pro", billing_period: "yearly" }],
    [VARIANT_MAX_MONTHLY, { plan: "max", billing_period: "monthly" }],
    [VARIANT_MAX_YEARLY, { plan: "max", billing_period: "yearly" }],
  ];
  const map = {};
  for (const [id, meta] of pairs) {
    if (present(id)) map[String(id)] = meta;
  }
  return map;
})();

/**
 * Resolve a (plan, billing_period) pair to its Lemon Squeezy variant id.
 * @returns {string|null} the variant id, or null when that pair is unconfigured
 */
export function planVariant(plan, billingPeriod) {
  const table = {
    "pro:monthly": VARIANT_PRO_MONTHLY,
    "pro:yearly": VARIANT_PRO_YEARLY,
    "max:monthly": VARIANT_MAX_MONTHLY,
    "max:yearly": VARIANT_MAX_YEARLY,
  };
  const id = table[`${plan}:${billingPeriod}`];
  return present(id) ? String(id) : null;
}

/** The configured store id as a string, or null. */
export function storeId() {
  return present(STORE_ID) ? String(STORE_ID) : null;
}

/**
 * True only when the store id and all four variant ids are present. The API key
 * and webhook secret are checked separately by the service's `isEnabled()`.
 */
export function isConfigured() {
  return Boolean(
    present(STORE_ID) &&
      present(VARIANT_PRO_MONTHLY) &&
      present(VARIANT_PRO_YEARLY) &&
      present(VARIANT_MAX_MONTHLY) &&
      present(VARIANT_MAX_YEARLY),
  );
}

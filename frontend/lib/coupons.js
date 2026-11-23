/**
 * Coupon codes (sql/40_coupons.sql). The database function redeem_coupon does the checks and the counting
 * under a row lock; this module maps its errors to user-facing messages and prices a pack.
 */
export const COUPON_MESSAGES = {
  coupon_invalid: "This coupon code is not valid or has expired.",
  coupon_not_applicable: "This coupon can't be used here.",
  coupon_used_up: "This coupon has been fully used.",
  coupon_already_used: "You have already used this coupon.",
};

export class CouponError extends Error {
  constructor(code) {
    super(COUPON_MESSAGES[code] || code);
    this.code = code;
    this.status = 400;
  }
}

export function normCouponCode(raw) {
  const c = String(raw ?? "").trim().toUpperCase();
  if (!c) return "";
  if (!/^[A-Z0-9_-]{3,40}$/.test(c)) throw new CouponError("coupon_invalid");
  return c;
}

/** Check (dry) or redeem. Resolves { redemptionId|null, kind, plan }; rejects CouponError. */
export async function redeemCoupon(db, { code, userId, target, dry = false }) {
  const { data, error } = await db.rpc("redeem_coupon", { p_code: code, p_user: userId, p_target: target, p_dry: dry });
  if (error) {
    const msg = String(error.message || "");
    const known = Object.keys(COUPON_MESSAGES).find((k) => msg.includes(k));
    if (known) throw new CouponError(known);
    throw error;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new CouponError("coupon_invalid");
  return { redemptionId: row.redemption_id || null, kind: row.kind, plan: row.plan };
}

export async function releaseCoupon(db, redemptionId) {
  if (!redemptionId) return;
  const { error } = await db.rpc("release_coupon", { p_redemption: redemptionId });
  if (error) console.warn(`[coupons] release ${redemptionId} failed: ${error.message || error}`);
}

/** Pack price after a coupon: free_all = 0, per_job_rupee = ₹1 per application (never above the list price). */
export function couponPackPrice(kind, packSize, listPaise) {
  if (kind === "free_all") return 0;
  if (kind === "per_job_rupee") return Math.min(Number(listPaise), Number(packSize) * 100);
  return Number(listPaise);
}

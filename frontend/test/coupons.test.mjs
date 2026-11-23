import test from "node:test";
import assert from "node:assert/strict";
import { couponPackPrice, normCouponCode, redeemCoupon, CouponError } from "../lib/coupons.js";

test("coupon pack price", () => {
  assert.equal(couponPackPrice("free_all", 50, 59900), 0);
  assert.equal(couponPackPrice("per_job_rupee", 50, 59900), 5000);
  assert.equal(couponPackPrice("per_job_rupee", 100, 89900), 10000);
  assert.equal(couponPackPrice("per_job_rupee", 100, 5000), 5000); // never above list price
  assert.equal(couponPackPrice(undefined, 50, 59900), 59900);
});

test("coupon code normalisation", () => {
  assert.equal(normCouponCode("  vloomfree "), "VLOOMFREE");
  assert.equal(normCouponCode(""), "");
  assert.throws(() => normCouponCode("bad code!"), CouponError);
});

test("redeemCoupon maps database errors", async () => {
  const db = { rpc: async () => ({ data: null, error: { message: "coupon_already_used" } }) };
  await assert.rejects(redeemCoupon(db, { code: "X1X", userId: "u", target: "plan" }), (e) => e.code === "coupon_already_used");
  const ok = { rpc: async () => ({ data: [{ redemption_id: "r1", kind: "free_all", plan: "max" }], error: null }) };
  assert.deepEqual(await redeemCoupon(ok, { code: "X1X", userId: "u", target: "plan" }), { redemptionId: "r1", kind: "free_all", plan: "max" });
});

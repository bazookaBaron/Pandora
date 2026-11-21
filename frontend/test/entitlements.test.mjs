import test from "node:test";
import assert from "node:assert/strict";
import { effectivePlanFromRow, isMissingFunctionError } from "../lib/entitlements.js";
import { computePeriodEnd } from "../lib/paymentsStore.js";

const NOW = Date.parse("2026-06-15T00:00:00Z");
const future = "2026-07-15T00:00:00Z";
const past = "2026-06-01T00:00:00Z";

test("active paid row with future period end keeps plan", () => {
  assert.equal(effectivePlanFromRow({ plan: "pro", status: "active", provider: "razorpay", current_period_end: future }, NOW), "pro");
});
test("active paid row past its period end downgrades to free", () => {
  assert.equal(effectivePlanFromRow({ plan: "max", status: "active", provider: "razorpay", current_period_end: past }, NOW), "free");
  assert.equal(effectivePlanFromRow({ plan: "pro", status: "on_trial", current_period_end: past }, NOW), "free");
});
test("active row without a period end is honoured (provider-backed or manual grant)", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(effectivePlanFromRow({ plan: "pro", status: "active", provider: "razorpay", current_period_end: null }, NOW), "pro");
  } finally {
    console.warn = warn;
  }
  assert.equal(effectivePlanFromRow({ plan: "pro", status: "active", provider: null, current_period_end: null }, NOW), "pro");
});
test("cancelled/past_due honour the paid-through date only", () => {
  assert.equal(effectivePlanFromRow({ plan: "pro", status: "cancelled", current_period_end: future }, NOW), "pro");
  assert.equal(effectivePlanFromRow({ plan: "pro", status: "past_due", current_period_end: past }, NOW), "free");
});
test("created/halted/expired/unknown and missing rows are free", () => {
  for (const status of ["created", "halted", "expired", "paused", "weird"]) {
    assert.equal(effectivePlanFromRow({ plan: "pro", status, current_period_end: future }, NOW), "free");
  }
  assert.equal(effectivePlanFromRow(null, NOW), "free");
  assert.equal(effectivePlanFromRow({ plan: "free", status: "active" }, NOW), "free");
});

test("computePeriodEnd extends from the later of now and existing end (same plan)", () => {
  const e = computePeriodEnd({ now: NOW, termDays: 30, plan: "pro", existing: { plan: "pro", status: "active", current_period_end: future } });
  assert.equal(e.toISOString(), new Date(Date.parse(future) + 30 * 86400000).toISOString());
});
test("computePeriodEnd starts from now for lapsed rows or a different plan", () => {
  const lapsed = computePeriodEnd({ now: NOW, termDays: 30, plan: "pro", existing: { plan: "pro", status: "active", current_period_end: past } });
  assert.equal(lapsed.getTime(), NOW + 30 * 86400000);
  const other = computePeriodEnd({ now: NOW, termDays: 365, plan: "max", existing: { plan: "pro", status: "active", current_period_end: future } });
  assert.equal(other.getTime(), NOW + 365 * 86400000);
});

test("reserve_usage fallback only for a missing function", () => {
  assert.equal(isMissingFunctionError({ code: "PGRST202", message: "Could not find the function public.reserve_usage" }), true);
  assert.equal(isMissingFunctionError({ code: "42883", message: "function public.reserve_usage(uuid) does not exist" }), true);
  assert.equal(isMissingFunctionError({ code: "57014", message: "canceling statement due to statement timeout" }), false);
  assert.equal(isMissingFunctionError({ code: "42501", message: "permission denied for function reserve_usage" }), false);
  assert.equal(isMissingFunctionError({ code: "", message: "fetch failed" }), false);
  assert.equal(isMissingFunctionError({ code: "42P01", message: 'relation "public.usage" does not exist' }), false);
});

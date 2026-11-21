import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCEPT_WINDOW_MS,
  acceptLimitFor,
  canViewResume,
  evaluateAcceptLimit,
  selectRecipients,
} from "../lib/referralAccess.js";

const NOW = Date.parse("2026-06-15T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const H = 3600_000;

test("limits: 3 unverified, 20 verified", () => {
  assert.equal(acceptLimitFor(false), 3);
  assert.equal(acceptLimitFor(true), 20);
});

test("unverified: allowed under 3, blocked at 3 within 24h", () => {
  const two = evaluateAcceptLimit({ verified: false, acceptedAt: [ago(H), ago(2 * H)], now: NOW });
  assert.equal(two.allowed, true);
  assert.equal(two.used, 2);
  const three = evaluateAcceptLimit({ verified: false, acceptedAt: [ago(H), ago(2 * H), ago(3 * H)], now: NOW });
  assert.equal(three.allowed, false);
  assert.equal(three.limit, 3);
  // Frees when the oldest (3h ago) leaves the window.
  assert.equal(three.retryAt, new Date(NOW - 3 * H + ACCEPT_WINDOW_MS).toISOString());
});

test("accepts older than 24h do not count (rolling window)", () => {
  const r = evaluateAcceptLimit({
    verified: false,
    acceptedAt: [ago(25 * H), ago(30 * H), ago(48 * H), ago(H)],
    now: NOW,
  });
  assert.equal(r.used, 1);
  assert.equal(r.allowed, true);
});

test("verified gets 20; blocked at 20", () => {
  const nineteen = Array.from({ length: 19 }, (_, i) => ago((i + 1) * 60_000));
  assert.equal(evaluateAcceptLimit({ verified: true, acceptedAt: nineteen, now: NOW }).allowed, true);
  const twenty = Array.from({ length: 20 }, (_, i) => ago((i + 1) * 60_000));
  const r = evaluateAcceptLimit({ verified: true, acceptedAt: twenty, now: NOW });
  assert.equal(r.allowed, false);
  assert.equal(r.limit, 20);
  // 3 accepts would be fine for a verified user.
  assert.equal(evaluateAcceptLimit({ verified: true, acceptedAt: twenty.slice(0, 3), now: NOW }).allowed, true);
});

test("garbage / null timestamps are ignored", () => {
  const r = evaluateAcceptLimit({ verified: false, acceptedAt: [null, "nope", undefined, ago(H)], now: NOW });
  assert.equal(r.used, 1);
});

test("resume: requester and accepter only", () => {
  const base = { posterUserId: "poster", acceptedByUserId: "acc", status: "accepted" };
  assert.equal(canViewResume({ ...base, userId: "poster" }), true);
  assert.equal(canViewResume({ ...base, userId: "acc" }), true);
  // Colleague at the same company (verified or not) is denied.
  assert.equal(canViewResume({ ...base, userId: "colleague" }), false);
});

test("resume: open request is visible to the requester only, never to others", () => {
  const open = { posterUserId: "poster", acceptedByUserId: null, status: "open" };
  assert.equal(canViewResume({ ...open, userId: "poster" }), true);
  assert.equal(canViewResume({ ...open, userId: "colleague" }), false);
  assert.equal(canViewResume({ ...open, userId: null }), false);
  assert.equal(canViewResume({ ...open, userId: undefined }), false);
});

test("resume: accepter loses access if request is no longer accepted", () => {
  assert.equal(
    canViewResume({ userId: "acc", posterUserId: "poster", acceptedByUserId: "acc", status: "cancelled" }),
    false,
  );
});

test("fan-out: verified first, capped at 50, skips missing emails", () => {
  const c = [];
  for (let i = 0; i < 40; i++) c.push({ email: `u${i}@x.com`, verified: false });
  for (let i = 0; i < 30; i++) c.push({ email: `v${i}@x.com`, verified: true });
  c.push({ email: null, verified: true });
  const out = selectRecipients(c);
  assert.equal(out.length, 50);
  assert.equal(out.slice(0, 30).every((r) => r.verified), true);
  assert.equal(out.slice(30).every((r) => !r.verified), true);
  assert.equal(out.some((r) => !r.email), false);
  assert.equal(selectRecipients(c, 5).length, 5);
});

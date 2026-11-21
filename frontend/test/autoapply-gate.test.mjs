/**
 * Profile-complete gate (lib/autoapply/profileGate.js): the same cases as
 * cloud_hunter/saas/tests/test_profile_gate.py.
 * Run: npm run test:autoapply
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { profileReady, profileCheck, missingPayload, REQUIRED_QUESTIONS } from "../lib/autoapply/profileGate.js";

const ROW = { user_id: "u1", profile: {}, resume_path: "u1/r.pdf", email_mode: "inbox", apply_alias: "asha.k7q2", onboarding_done: true, consent_at: "2026-11-01T00:00:00Z" };
const COMPLETE = {
  "fields.first_name": "Asha", "fields.last_name": "Rao", "fields.phone": "+91 98765 43210",
  "fields.city": "Bengaluru", "fields.country": "India", "fields.current_company": "Orbitronix",
  "fields.current_title": "Software Engineer", "fields.school": "VTU", "fields.degree": "B.E. CSE",
  "facts.total_experience_years": "4", "facts.notice_period_days": "30", "facts.work_authorized_in": "IN",
  "facts.needs_sponsorship": "no", "facts.willing_to_relocate": "yes", "facts.currently_employed": "yes",
};
const without = (keys) => Object.fromEntries(Object.entries(COMPLETE).filter(([k]) => !keys.includes(k)));
const ready = (u, a) => {
  const r = profileReady(u, a);
  return [r.ok, r.missing];
};

test("gate: required questions mirror questions.js (same 11 as profile_gate.py)", () => {
  assert.deepEqual(Object.keys(REQUIRED_QUESTIONS), [
    "fields.first_name", "fields.last_name", "fields.phone", "fields.city", "fields.country",
    "facts.total_experience_years", "facts.notice_period_days", "facts.work_authorized_in",
    "facts.needs_sponsorship", "facts.willing_to_relocate", "facts.currently_employed",
  ]);
});

test("gate: complete profile is ready (answers arg or row.answers)", () => {
  assert.deepEqual(ready(ROW, COMPLETE), [true, []]);
  assert.deepEqual(ready({ ...ROW, answers: COMPLETE }), [true, []]);
});

test("gate: nothing at all", () => {
  const [ok, missing] = ready({}, {});
  assert.equal(ok, false);
  assert.deepEqual(missing.slice(0, 3), ["onboarding", "resume", "email"]);
  for (const k of ["name", "phone", "location", "current_company", "current_title", "experience_years", "education", "facts.notice_period_days", "facts.currently_employed"]) {
    assert.ok(missing.includes(k), k);
  }
  assert.ok(!missing.includes("fields.first_name") && !missing.includes("fields.phone"));
  assert.deepEqual(ready(null, null)[1].slice(0, 3), ["onboarding", "resume", "email"]);
});

test("gate: parsed resume fills the profile items", () => {
  const profile = {
    name: "Asha Rao", phone: "+91 98765 43210", location: "Bengaluru, India",
    experience: [{ company: "Initech", title: "SDE", start: "2022-06", current: true }],
    education: [{ school: "IIT X", degree: "B.Tech" }],
  };
  const ans = Object.fromEntries(Object.entries(COMPLETE).filter(([k]) => !k.startsWith("fields.")));
  assert.deepEqual(ready({ ...ROW, profile }, ans), [true, []]);
});

test("gate: each required answer", () => {
  for (const [drop, expect] of [
    ["fields.phone", "phone"], ["facts.total_experience_years", "experience_years"],
    ["facts.notice_period_days", "facts.notice_period_days"], ["fields.city", "location"],
    ["facts.currently_employed", "facts.currently_employed"], ["fields.current_title", "current_title"],
  ]) {
    assert.deepEqual(ready(ROW, without([drop])), [false, [expect]], drop);
  }
  assert.deepEqual(ready(ROW, { ...COMPLETE, "facts.total_experience_years": "four" }), [false, ["experience_years"]]);
});

test("gate: defaults count only after onboarding", () => {
  const ans = without(["fields.country", "facts.work_authorized_in", "facts.needs_sponsorship", "facts.willing_to_relocate"]);
  assert.deepEqual(ready(ROW, ans), [true, []]);
  assert.deepEqual(ready({ ...ROW, onboarding_done: false }, ans)[1], [
    "onboarding", "fields.country", "facts.work_authorized_in", "facts.needs_sponsorship", "facts.willing_to_relocate",
  ]);
});

test("gate: not employed needs no current job", () => {
  const ans = without(["fields.current_company", "fields.current_title"]);
  assert.deepEqual(ready(ROW, ans), [false, ["current_company", "current_title"]]);
  assert.deepEqual(ready(ROW, { ...ans, "facts.currently_employed": "no" }), [true, []]);
});

test("gate: email modes, resume, single-word name", () => {
  assert.deepEqual(ready({ ...ROW, apply_alias: null }, COMPLETE), [false, ["email"]]);
  assert.deepEqual(ready({ ...ROW, email_mode: "gmail_forward" }, COMPLETE), [false, ["email"]]);
  assert.equal(ready({ ...ROW, email_mode: "gmail_forward", contact_email: "a@b.c" }, COMPLETE)[0], true);
  assert.deepEqual(ready({ ...ROW, resume_path: "  " }, COMPLETE), [false, ["resume"]]);
  assert.deepEqual(ready({ ...ROW, profile: { name: "Asha" } }, without(["fields.last_name"])), [false, ["name"]]);
});

test("gate: labels payload", () => {
  assert.deepEqual(missingPayload(["resume", "phone", "facts.notice_period_days"]), [
    { key: "resume", label: "Upload your resume" },
    { key: "phone", label: "Phone (with country code)" },
    { key: "facts.notice_period_days", label: "Notice period (days)" },
  ]);
  assert.deepEqual(profileCheck(ROW, without(["fields.phone"])), { ok: false, missing: [{ key: "phone", label: "Phone (with country code)" }] });
});

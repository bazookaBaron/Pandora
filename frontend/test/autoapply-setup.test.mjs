/**
 * Setup form schema + validation (lib/autoapply/setupOptions.js), shared by the Setup page and the API.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  QUESTIONS, checkAnswer, validateSetupAnswers, validatePrefsInput, validateProfileDraft, normalisePhone, scoreLevel, SCHEMA_BY_KEY,
} from "../lib/autoapply/setupOptions.js";
import { validateAnswer } from "../lib/autoapply/questions.js";

const Q = (k) => SCHEMA_BY_KEY.get(k);
const TODAY = new Date("2026-11-24T00:00:00Z");

test("setup: keys the worker reads are all asked (profile_build.py)", () => {
  const keys = new Set(QUESTIONS.map((q) => q.key));
  for (const k of ["fields.first_name", "fields.last_name", "fields.phone", "fields.linkedin", "fields.github", "fields.current_company",
    "fields.current_title", "fields.address_line1", "fields.city", "fields.state", "fields.postal_code", "fields.country", "fields.school",
    "fields.degree", "facts.date_of_birth", "facts.notice_period_days", "facts.current_ctc_lpa", "facts.expected_ctc_lpa",
    "facts.total_experience_years", "facts.work_authorized_in", "facts.needs_sponsorship", "facts.willing_to_relocate",
    "facts.currently_employed", "facts.highest_degree", "facts.graduation_year", "facts.gender", "facts.ethnicity", "facts.disability",
    "facts.veteran", "facts.how_did_you_hear", "facts.earliest_start_days"]) assert.ok(keys.has(k), k);
  // everything but the optional extra website is required
  assert.deepEqual(QUESTIONS.filter((q) => !q.required && !q.requiredIf).map((q) => q.key), ["fields.website"]);
});

test("setup: phone is normalised to +91, other numbers rejected", () => {
  for (const raw of ["9876543210", "+91 98765-43210", "09876543210", "919876543210"]) assert.equal(normalisePhone(raw), "+91 98765 43210", raw);
  for (const raw of ["12345", "+1 415 555 0100", "5876543210"]) assert.equal(checkAnswer(Q("fields.phone"), raw).ok, false, raw);
});

test("setup: urls, pin, names, dates", () => {
  assert.equal(checkAnswer(Q("fields.linkedin"), "https://www.linkedin.com/in/asha-rao").ok, true);
  assert.equal(checkAnswer(Q("fields.linkedin"), "linkedin.com/asha").ok, false);
  assert.equal(checkAnswer(Q("fields.linkedin"), "javascript:alert(1)").ok, false);
  assert.equal(checkAnswer(Q("fields.github"), "https://github.com/asha").ok, true);
  assert.equal(checkAnswer(Q("fields.github"), "http://github.com/asha").ok, false);
  assert.equal(checkAnswer(Q("fields.postal_code"), "560001").ok, true);
  assert.equal(checkAnswer(Q("fields.postal_code"), "05600").ok, false);
  assert.equal(checkAnswer(Q("fields.first_name"), "Débo Priyo").ok, true);
  assert.equal(checkAnswer(Q("fields.first_name"), "<script>").ok, false);
  assert.equal(checkAnswer(Q("fields.address_line1"), "12 MG Road <b>").ok, false);
  assert.equal(checkAnswer(Q("fields.address_line1"), "x".repeat(151)).ok, false);
  const dob = Q("facts.date_of_birth");
  assert.deepEqual(checkAnswer(dob, "1999-02-14", { today: TODAY }), { ok: true, value: "1999-02-14" });
  assert.equal(checkAnswer(dob, "1999-02-30", { today: TODAY }).ok, false);
  assert.equal(checkAnswer(dob, "2015-01-01", { today: TODAY }).ok, false); // under 16
});

test("setup: selects / multiselects take value or label, return the canonical value", () => {
  assert.deepEqual(checkAnswer(Q("facts.notice_period_days"), "30"), { ok: true, value: "30" });
  assert.deepEqual(checkAnswer(Q("facts.notice_period_days"), "30 days (1 month)"), { ok: true, value: "30" });
  assert.equal(checkAnswer(Q("facts.notice_period_days"), "1 month-ish").ok, false);
  assert.deepEqual(checkAnswer(Q("facts.how_did_you_hear"), "linkedin"), { ok: true, value: "LinkedIn" });
  assert.deepEqual(checkAnswer(Q("facts.languages"), "english, Hindi"), { ok: true, value: "English, Hindi" });
  assert.equal(checkAnswer(Q("facts.languages"), "English, Klingon").ok, false);
  assert.deepEqual(validateAnswer("facts.work_authorized_in", ["IN", "us"]), { ok: true, value: "IN,US" });
  assert.equal(checkAnswer(Q("facts.current_ctc_lpa"), "12").value, "12");
});

test("setup: whole form -> required + requiredIf", () => {
  const { errors } = validateSetupAnswers({ "facts.currently_employed": "no" });
  assert.equal(errors["fields.first_name"], "Required.");
  assert.equal(errors["fields.current_company"], undefined); // only when employed
  assert.equal(errors["fields.website"], undefined);
  assert.equal(validateSetupAnswers({ "facts.currently_employed": "yes" }).errors["fields.current_company"], "Required.");
});

test("setup: prefs -> curated titles (max 5), listed locations, three match levels", () => {
  const ok = validatePrefsInput({ titles: ["backend engineer"], locations: ["bengaluru", "Pan India"], min_score: 30 });
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.prefs.titles, ["Backend Engineer"]);
  assert.deepEqual(ok.prefs.locations, ["Bengaluru", "Pan India"]);
  assert.ok(validatePrefsInput({ titles: [], locations: ["Remote"] }).errors.titles);
  assert.ok(validatePrefsInput({ titles: ["Chief Vibes Officer"], locations: ["Remote"] }).errors.titles);
  assert.ok(validatePrefsInput({ titles: ["Backend Engineer"], locations: ["Atlantis"] }).errors.locations);
  const six = ["Software Engineer", "Backend Engineer", "Frontend Engineer", "Data Engineer", "DevOps Engineer", "Cloud Engineer"];
  assert.ok(validatePrefsInput({ titles: six, locations: ["Remote"] }).errors.titles);
  assert.ok(validatePrefsInput({ titles: ["Backend Engineer"], locations: ["Remote"], min_score: 60 }).errors.min_score);
  assert.equal(validatePrefsInput({ titles: ["Backend Engineer"], locations: ["Remote"] }).prefs.min_score, 20);
  // saved prefs without a level (null) or with an old slider value sent back unchanged: Balanced / nearest level
  assert.equal(validatePrefsInput({ titles: ["Backend Engineer"], locations: ["Remote"], min_score: null }).prefs.min_score, 20);
  const legacy = validatePrefsInput({ titles: ["Backend Engineer"], locations: ["Remote"], min_score: 45 }, { saved: { min_score: 45 } });
  assert.deepEqual(legacy.errors, {});
  assert.equal(legacy.prefs.min_score, 30);
  assert.ok(validatePrefsInput({ titles: ["Backend Engineer"], locations: ["Remote"], min_score: 45 }, { saved: { min_score: 20 } }).errors.min_score);
  assert.deepEqual([scoreLevel(0), scoreLevel(15), scoreLevel(60)], [0, 20, 30]);
});

test("setup: resume draft needs title + company per job and (strict) a skill", () => {
  assert.deepEqual(validateProfileDraft({ first_name: "A" }), {});
  const e = validateProfileDraft({ experience: [{ title: "SDE", company: "" }], skills: [] }, { strict: true });
  assert.ok(e["experience.0.company"] && e.skills);
  assert.deepEqual(validateProfileDraft({ experience: [{ title: "SDE", company: "Acme" }], skills: ["Go"] }, { strict: true }), {});
});

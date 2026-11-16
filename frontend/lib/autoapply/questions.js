/**
 * AutoApply standard question list (contract: docs/autoapply-contract.md,
 * "Standard answers"). `fields.*` map 1:1 to answers.json -> fields in the bot;
 * `facts.*` are typed facts the bot uses to answer screening questions.
 *
 * Learned answers (from needs-you) use keys `q.<sha1(normalised label)[:16]>`.
 */
import crypto from "node:crypto";

const YES_NO = ["yes", "no"];
const DECLINE_HELP = "Free value, or 'decline' to not disclose.";

const f = (key, label, extra = {}) => ({ key, label, type: "text", required: false, ...extra });

export const QUESTIONS = [
  f("fields.first_name", "First name", { required: true }),
  f("fields.last_name", "Last name", { required: true }),
  f("fields.phone", "Phone (with country code)", { required: true, help: "e.g. +91 98765 43210" }),
  f("fields.linkedin", "LinkedIn URL"),
  f("fields.github", "GitHub URL"),
  f("fields.website", "Website / portfolio URL"),
  f("fields.current_company", "Current company"),
  f("fields.current_title", "Current job title"),
  f("fields.address_line1", "Address line 1"),
  f("fields.city", "City", { required: true }),
  f("fields.state", "State"),
  f("fields.postal_code", "Postal code"),
  f("fields.country", "Country", { required: true, default: "India" }),
  f("fields.school", "School / university"),
  f("fields.degree", "Degree"),

  f("facts.total_experience_years", "Total experience (years)", { type: "number", required: true }),
  f("facts.notice_period_days", "Notice period (days)", { type: "number", required: true }),
  f("facts.current_ctc_lpa", "Current CTC (INR lakh / year)", { type: "number" }),
  f("facts.expected_ctc_lpa", "Expected CTC (INR lakh / year)", { type: "number" }),
  f("facts.work_authorized_in", "Countries you are authorised to work in", {
    required: true,
    default: "IN",
    help: "Comma-separated ISO-2 codes, e.g. IN or IN,US",
  }),
  f("facts.needs_sponsorship", "Do you need visa sponsorship?", { type: "select", options: YES_NO, required: true, default: "no" }),
  f("facts.willing_to_relocate", "Willing to relocate?", { type: "select", options: YES_NO, required: true, default: "yes" }),
  f("facts.currently_employed", "Currently employed?", { type: "select", options: YES_NO, required: true }),
  f("facts.earliest_start_days", "Earliest start (days from offer)", { type: "number" }),
  f("facts.graduation_year", "Graduation year", { type: "number" }),
  f("facts.highest_degree", "Highest degree", {
    type: "select",
    options: ["high_school", "diploma", "bachelor", "master", "phd", "other"],
  }),
  f("facts.date_of_birth", "Date of birth (optional)", { type: "date" }),
  f("facts.gender", "Gender", { type: "select", options: ["male", "female", "non_binary", "decline"], default: "decline", help: DECLINE_HELP, free: true }),
  f("facts.ethnicity", "Ethnicity", { type: "select", options: ["asian", "decline"], default: "decline", help: DECLINE_HELP, free: true }),
  f("facts.disability", "Disability", { type: "select", options: ["no", "yes", "decline"], default: "decline", help: DECLINE_HELP, free: true }),
  f("facts.veteran", "Veteran status", { type: "select", options: ["no", "yes", "decline"], default: "decline", help: DECLINE_HELP, free: true }),
  f("facts.how_did_you_hear", "How did you hear about us?", { default: "LinkedIn" }),
];

export const QUESTION_BY_KEY = new Map(QUESTIONS.map((q) => [q.key, q]));

export const LEARNED_KEY_RE = /^q\.[0-9a-f]{16}$/;
const MAX_ANSWER_LEN = 2000;

/** Label normalisation shared with the Python side: NFKC, lowercase,
 *  every run of non [a-z0-9] chars -> one space, trimmed. */
export function normaliseLabel(label) {
  return String(label || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function learnedKey(label) {
  return "q." + crypto.createHash("sha1").update(normaliseLabel(label), "utf8").digest("hex").slice(0, 16);
}

export function isValidKey(key) {
  return QUESTION_BY_KEY.has(key) || LEARNED_KEY_RE.test(String(key || ""));
}

/** Public list (strips internal flags). */
export function publicQuestions() {
  return QUESTIONS.map(({ free, ...q }) => q);
}

/**
 * Validate one answer. Returns { ok: true, value: string|null } (null = delete)
 * or { ok: false, message }.
 */
export function validateAnswer(key, value) {
  if (!isValidKey(key)) return { ok: false, message: `Unknown question key: ${key}` };
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return { ok: false, message: `${key}: answer must be a string or number.` };
  }
  let v = String(value).trim();
  if (v.length > MAX_ANSWER_LEN) return { ok: false, message: `${key}: answer is too long.` };
  const q = QUESTION_BY_KEY.get(key);
  if (!q) return { ok: true, value: v }; // learned answer: free text
  if (q.type === "number") {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { ok: false, message: `${key}: must be a non-negative number.` };
    v = String(n);
  } else if (q.type === "select" && !q.free) {
    v = v.toLowerCase();
    if (!q.options.includes(v)) return { ok: false, message: `${key}: must be one of ${q.options.join(", ")}.` };
  } else if (q.type === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
      return { ok: false, message: `${key}: must be YYYY-MM-DD.` };
    }
  } else if (key === "facts.work_authorized_in") {
    const codes = v.toUpperCase().split(",").map((s) => s.trim()).filter(Boolean);
    if (!codes.length || !codes.every((c) => /^[A-Z]{2}$/.test(c))) {
      return { ok: false, message: `${key}: comma-separated ISO-2 country codes, e.g. IN.` };
    }
    v = codes.join(",");
  }
  return { ok: true, value: v };
}

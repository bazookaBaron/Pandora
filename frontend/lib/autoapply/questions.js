/**
 * AutoApply standard question list (contract: docs/autoapply-contract.md, "Standard answers").
 * The schema itself (keys, types, options, validation) lives in ./setupOptions.js, shared with the Setup page.
 * `fields.*` map 1:1 to answers.json -> fields in the bot; `facts.*` are typed facts the bot uses to answer
 * screening questions (cloud_hunter/saas/worker/profile_build.py).
 *
 * Learned answers (from needs-you) use keys `q.<sha1(normalised label)[:16]>`.
 */
import crypto from "node:crypto";
import { QUESTIONS as SCHEMA, checkAnswer, cleanText, optionsOf, MAX_FREE_LEN, isRequired } from "./setupOptions.js";

export const QUESTIONS = SCHEMA;
export const QUESTION_BY_KEY = new Map(QUESTIONS.map((q) => [q.key, q]));

export const LEARNED_KEY_RE = /^q\.[0-9a-f]{16}$/;

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

/** Public list with options expanded (the client re-checks answers with setupOptions.js). */
export function publicQuestions() {
  return QUESTIONS.map((q) => (q.options ? { ...q, options: optionsOf(q) } : { ...q }));
}

/** True when this standard question is required, given the user's other answers. */
export function isRequiredKey(key, answers = {}) {
  const q = QUESTION_BY_KEY.get(key);
  return !!q && isRequired(q, answers);
}

/**
 * Validate one answer. Returns { ok: true, value: string|null } (null = delete)
 * or { ok: false, message }.
 */
export function validateAnswer(key, value) {
  if (!isValidKey(key)) return { ok: false, message: `Unknown question key: ${key}` };
  const q = QUESTION_BY_KEY.get(key);
  if (!q) {
    // learned answer: free text, cleaned and length-limited
    if (value === null || value === undefined) return { ok: true, value: null };
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return { ok: false, message: `${key}: answer must be a string or number.` };
    }
    const v = cleanText(value);
    if (v.length > MAX_FREE_LEN) return { ok: false, message: `${key}: answer is too long.` };
    return { ok: true, value: v || null };
  }
  const r = checkAnswer(q, value);
  if (!r.ok) return { ok: false, message: `${q.label}: ${r.message}` };
  return { ok: true, value: r.value || null };
}

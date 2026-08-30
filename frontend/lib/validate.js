/**
 * Tiny, dependency-free request-validation helpers.
 *
 * `assert(cond, msg)` throws an Error tagged with `status = 400` so route
 * handlers (and a shared error middleware) can turn a failed check into a
 * clean `400 { error: <msg> }` without leaking a stack trace or upstream
 * context to the client.
 */

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
    this.expose = true;
  }
}

export function assert(cond, msg) {
  if (!cond) throw new ValidationError(msg || "Invalid request.");
}

export function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

export function isString(v) {
  return typeof v === "string";
}

export function maxLen(v, n) {
  return typeof v === "string" && v.length <= n;
}

export function inRange(v, min, max) {
  return typeof v === "string" && v.length >= min && v.length <= max;
}

export function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

export function isArray(v) {
  return Array.isArray(v);
}

/**
 * Loose base64 sniff: only the base64 alphabet (+ optional whitespace and
 * padding). Does NOT decode. Use `decodedLen()` for a size gate.
 */
export function looksBase64(v) {
  if (typeof v !== "string" || v.length === 0) return false;
  const cleaned = v.replace(/\s+/g, "");
  if (cleaned.length % 4 !== 0 && !/=$/.test(cleaned)) {
    // some encoders drop padding — allow it, just check the alphabet
  }
  return /^[A-Za-z0-9+/]+={0,2}$/.test(cleaned);
}

/** Approx decoded byte length of a base64 string (ignores whitespace). */
export function decodedLen(v) {
  if (typeof v !== "string") return 0;
  const cleaned = v.replace(/\s+/g, "");
  const padding = (cleaned.match(/=+$/) || [""])[0].length;
  return Math.floor((cleaned.length * 3) / 4) - padding;
}

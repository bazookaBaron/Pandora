/**
 * Work-email company verification helpers (pure, no I/O except the lazy
 * domain-map import).
 *
 * A user proves they work at a company by receiving a 6-digit code at an
 * address on that company's domain. `emailMatchesCompany` decides whether an
 * email domain is plausible for the claimed company name.
 */
import crypto from "node:crypto";

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.in", "yahoo.co.in",
  "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com",
  "proton.me", "protonmail.com", "aol.com", "gmx.com", "zoho.com", "yandex.com",
  "mail.com", "rediffmail.com", "pm.me", "tutanota.com", "fastmail.com",
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
]);

// Second-level suffixes where the registrable domain has three labels.
const MULTI_SLD = new Set([
  "co.uk", "co.in", "co.jp", "co.kr", "co.nz", "co.za", "com.au", "com.br",
  "com.sg", "com.cn", "com.mx", "org.uk", "ac.uk", "gov.uk", "net.in", "org.in",
]);

const CORP_WORDS =
  /\b(incorporated|inc|llc|ltd|limited|pvt|private|corp|corporation|company|co|technologies|technology|tech|labs|software|systems|solutions|india|group|holdings|plc|gmbh)\b/g;

/** lowercase alnum only. */
function squash(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Normalise a company name: strip corporate suffixes then squash. */
export function normalizeCompany(name) {
  const base = String(name || "")
    .toLowerCase()
    .replace(/[.,'’&()]/g, " ")
    .replace(CORP_WORDS, " ");
  return squash(base);
}

/** registrable domain of a hostname (eTLD+1 heuristic). */
export function registrableDomain(host) {
  const parts = String(host || "").toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const last2 = parts.slice(-2).join(".");
  if (MULTI_SLD.has(last2)) return parts.slice(-3).join(".");
  return last2;
}

export function emailDomain(email) {
  const m = /^[^\s@]{1,64}@([^\s@]{1,255})$/.exec(String(email || "").trim());
  return m ? m[1].toLowerCase() : null;
}

export function isFreeMailDomain(domain) {
  return FREE_MAIL.has(registrableDomain(domain));
}

let _domainMap = null;
async function loadDomainMap() {
  if (_domainMap) return _domainMap;
  try {
    const mod = await import("../src/lib/companyDomains.js");
    _domainMap = mod.COMPANY_DOMAIN_MAP || {};
  } catch {
    _domainMap = {};
  }
  return _domainMap;
}

/** Test hook. */
export function _setDomainMap(m) {
  _domainMap = m;
}

/**
 * Does `email` plausibly belong to `company`?
 * 1. Free-mail / disposable domains never match.
 * 2. If the company is in the curated map, the email's registrable domain must
 *    equal the registrable domain of one of its mapped domains.
 * 3. Otherwise heuristic: the domain's registrable label must equal the FULL
 *    normalised company name. No first-word / prefix matching: that let
 *    "Bank of America" accept any @bank.com address.
 *
 * @returns {Promise<{ ok: boolean, domain: string|null, reason?: string }>}
 */
export async function emailMatchesCompany(email, company) {
  const domain = emailDomain(email);
  if (!domain) return { ok: false, domain: null, reason: "invalid_email" };
  if (isFreeMailDomain(domain)) return { ok: false, domain, reason: "personal_email" };
  const reg = registrableDomain(domain);

  const map = await loadDomainMap();
  const want = String(company || "").trim().toLowerCase();
  const wantNorm = normalizeCompany(company);
  const mapped = new Set();
  for (const [name, dom] of Object.entries(map)) {
    if (name.toLowerCase() === want || normalizeCompany(name) === wantNorm) {
      mapped.add(registrableDomain(dom));
    }
  }
  if (mapped.size) {
    return mapped.has(reg)
      ? { ok: true, domain: reg }
      : { ok: false, domain: reg, reason: "domain_mismatch" };
  }

  const label = squash(reg.split(".")[0]);
  const candidates = new Set([wantNorm, squash(company)]);
  candidates.delete("");
  return label.length >= 2 && candidates.has(label)
    ? { ok: true, domain: reg }
    : { ok: false, domain: reg, reason: "domain_mismatch" };
}

export function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

let _warnedNoSecret = false;
/**
 * HMAC key for verification codes: COMPANY_VERIFY_SECRET only (never reuse the
 * service-role key). In production an unset secret FAILS CLOSED (returns null,
 * logged once); outside production a fixed dev key is used.
 */
function secret() {
  const s = process.env.COMPANY_VERIFY_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") {
    if (!_warnedNoSecret) {
      _warnedNoSecret = true;
      console.error("[companyVerify] COMPANY_VERIFY_SECRET is unset or shorter than 16 chars - work-email verification is disabled.");
    }
    return null;
  }
  return s || "dev-only-company-verify-secret";
}

/** False when verification must be refused (production without a secret). */
export function verifySecretConfigured() {
  return secret() !== null;
}

export function hashCode(userId, code) {
  const key = secret();
  if (!key) {
    const e = new Error("company verification secret not configured");
    e.code = "verify_unconfigured";
    throw e;
  }
  return crypto
    .createHmac("sha256", key)
    .update(`${userId}|${code}`)
    .digest("hex");
}

export function codesEqual(aHex, bHex) {
  const a = Buffer.from(String(aHex), "utf8");
  const b = Buffer.from(String(bHex), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

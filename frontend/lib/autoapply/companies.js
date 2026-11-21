/**
 * Company-name helpers. Pure, no I/O.
 *
 *   companyKey(name)            'Acme Technologies Pvt. Ltd.' -> 'acme'  (for matching tasks to mail)
 *   normMustCompanies(value)    validate aa_batches.must_companies input (<= 10, trimmed, <= 80 chars, de-duplicated)
 */
export const MUST_COMPANIES_MAX = 10;
export const MUST_COMPANY_MAX_LEN = 80;

const SUFFIXES =
  /\b(incorporated|inc|llc|llp|ltd|limited|pvt|private|plc|corp|corporation|co|company|gmbh|ag|sa|bv|technologies|technology|tech|solutions|software|services|systems|labs|group|india|global|careers|recruiting|talent|hiring|team)\b/g;

export function companyKey(name) {
  const base = String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ");
  const stripped = base.replace(SUFFIXES, " ").replace(/\s+/g, " ").trim();
  return (stripped || base.replace(/\s+/g, " ").trim()).replace(/ /g, "");
}

/** Two company names refer to the same company (exact key, or one key is a prefix of the other with >= 4 chars). */
export function sameCompany(a, b) {
  const x = companyKey(a);
  const y = companyKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.startsWith(short);
}

/**
 * @returns {{ok: true, value: string[]} | {ok: false, message: string}}
 * undefined / null -> [] ; a comma / newline separated string is accepted too.
 */
export function normMustCompanies(v) {
  if (v === undefined || v === null || v === "") return { ok: true, value: [] };
  const list = typeof v === "string" ? v.split(/[\n,]/) : v;
  if (!Array.isArray(list)) return { ok: false, message: "must_companies must be an array of company names." };
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== "string") return { ok: false, message: "must_companies must contain only text." };
    const name = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (!name) continue;
    if (name.length > MUST_COMPANY_MAX_LEN) return { ok: false, message: `Each company name must be ${MUST_COMPANY_MAX_LEN} characters or fewer.` };
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  if (out.length > MUST_COMPANIES_MAX) return { ok: false, message: `Pick at most ${MUST_COMPANIES_MAX} must-apply companies.` };
  return { ok: true, value: out };
}

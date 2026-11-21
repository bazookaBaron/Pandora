/**
 * Profile-complete gate, the same rules as cloud_hunter/saas/profile_gate.py (the scheduler holds a paid
 * batch in 'waiting_profile' until these pass). Pure, no I/O.
 *
 *   profileReady(profileRow, answers) -> { ok, missing: [key...] }
 *   missingPayload(missing)           -> [{ key, label }]
 *   profileReadiness(profileRow, answers) -> { ok, pct, done, total, missing: [{ key, label, fix }] }
 *
 * `profileRow` is an aa_profiles row; `answers` is {question_key: answer} from aa_answers.
 * Keep in sync with profile_gate.py (LABELS, REQUIRED_QUESTIONS, COVERED and the fallbacks).
 */
import { QUESTIONS } from "./questions.js";

export const PROFILE_LABELS = {
  onboarding: "Finish the AutoApply onboarding",
  resume: "Upload your resume",
  email: "Set the email address we apply with",
  name: "Full name",
  phone: "Phone (with country code)",
  location: "Current location (city)",
  current_company: "Current company",
  current_title: "Current job title",
  experience_years: "Total experience (years)",
  education: "Education (school / degree)",
};

/** questions.js `required: true` -> { label, default } (a default counts as answered once onboarding is done). */
export const REQUIRED_QUESTIONS = Object.fromEntries(
  QUESTIONS.filter((q) => q.required).map((q) => [q.key, { label: q.label, default: q.default ?? null }]),
);

const COVERED = {
  name: ["fields.first_name", "fields.last_name"],
  phone: ["fields.phone"],
  location: ["fields.city"],
  experience_years: ["facts.total_experience_years"],
};
const PROFILE_ITEMS = ["name", "phone", "location", "current_company", "current_title", "experience_years", "education"];

const s = (v) => (v === null || v === undefined ? "" : String(v).trim());
const num = (v) => {
  const t = s(v).replace(/,/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function currentJob(p) {
  for (const e of Array.isArray(p.experience) ? p.experience : []) {
    if (isObj(e) && (e.current || !s(e.end || e.to || e.end_date))) return e;
  }
  return {};
}
const education = (p) => (Array.isArray(p.education) ? p.education : []).find(isObj) || {};

export function profileLabel(key) {
  return PROFILE_LABELS[key] || (REQUIRED_QUESTIONS[key] && REQUIRED_QUESTIONS[key].label) || key;
}

export function profileReady(user, answers) {
  const { missing } = evaluate(user, answers);
  return { ok: missing.length === 0, missing };
}

/** Every gate item checked for this user -> { missing: [key...], total, blocked }. `blocked` = required questions
 *  that are not asked separately because the profile item that covers them is still missing (not done either). */
function evaluate(user, answers) {
  const u = user || {};
  const a = answers || u.answers || {};
  const p = isObj(u.profile) ? u.profile : {};
  const done = !!u.onboarding_done;
  const miss = [];
  if (!done) miss.push("onboarding");
  if (!s(u.resume_path)) miss.push("resume");
  if (u.email_mode === "gmail_forward") {
    if (!s(u.contact_email)) miss.push("email");
  } else if (!(s(u.apply_alias) || s(u.contact_email))) miss.push("email");

  const first = s(a["fields.first_name"] || p.first_name);
  const last = s(a["fields.last_name"] || p.last_name);
  const full = s(p.name);
  const edu = education(p);
  const has = {
    name: !!((first && last) || full.split(/\s+/).filter(Boolean).length >= 2),
    phone: !!s(a["fields.phone"] || p.phone),
    location: !!s(a["fields.city"] || p.location || p.city),
    experience_years: num(a["facts.total_experience_years"]) !== null,
    education: !!(s(a["fields.school"] || a["fields.degree"]) || s(edu.school || edu.institution || edu.degree)),
  };
  const employed = s(a["facts.currently_employed"]).toLowerCase() !== "no";
  if (employed) {
    const job = currentJob(p);
    has.current_company = !!s(a["fields.current_company"] || job.company);
    has.current_title = !!s(a["fields.current_title"] || job.title);
  }
  for (const k of PROFILE_ITEMS) if (k in has && !has[k]) miss.push(k);

  const coveredOk = new Set(Object.entries(COVERED).filter(([item]) => has[item]).flatMap(([, qs]) => qs));
  let blocked = 0;
  for (const [key, q] of Object.entries(REQUIRED_QUESTIONS)) {
    if (s(a[key]) || coveredOk.has(key) || (q.default !== null && done)) continue;
    if (Object.entries(COVERED).some(([item, qs]) => miss.includes(item) && qs.includes(key))) { blocked++; continue; }
    miss.push(key);
  }
  const total = 3 + Object.keys(has).length + Object.keys(REQUIRED_QUESTIONS).length;
  return { missing: miss, total, blocked };
}

export const missingPayload = (missing) => (missing || []).map((key) => ({ key, label: profileLabel(key) }));

/** { ok, missing: [{key, label}] } for GET /me. */
export function profileCheck(user, answers) {
  const r = profileReady(user, answers);
  return { ok: r.ok, missing: missingPayload(r.missing) };
}

// missing key -> the Setup step that fixes it (same mapping as the client's setupStepFor in pages/autoapply/ui.jsx)
const FIX_STEP = { onboarding: "consent", resume: "resume", email: "email" };
export const fixLinkFor = (key) => `/autoapply/setup?step=${FIX_STEP[key] || "answers"}${FIX_STEP[key] ? "" : `&field=${encodeURIComponent(key)}`}`;

/**
 * Readiness score for the home / Buy pages: the same items as the gate, as a percentage.
 * -> { ok, pct, done, total, missing: [{ key, label, fix }] }   (pct is 100 only when ok)
 */
export function profileReadiness(user, answers) {
  const { missing, total, blocked } = evaluate(user, answers);
  const done = Math.max(0, total - missing.length - blocked);
  const ok = missing.length === 0;
  const pct = ok ? 100 : Math.min(99, Math.floor((done / total) * 100));
  return { ok, pct, done, total, missing: missingPayload(missing).map((m) => ({ ...m, fix: fixLinkFor(m.key) })) };
}

/**
 * Read-side views over tasks and mail. Pure, no I/O.
 *
 *   chargeSummary(tasks)                 batch page: applied vs not charged (failed / captcha / blocked / other)
 *   matchConfirmationMails(tasks, mails) applied task id -> the 'received' mail that confirms it (same company,
 *                                        arrived from 10 min before to 3 days after the submit)
 *   roleFamily(title)                    'Senior Backend Engineer' -> 'backend'
 *   replyStats({tasks, mails, interviews, now}) per company and per role family, last 90 days
 */
import { companyKey, sameCompany } from "./companies.js";

// ── not charged ─────────────────────────────────────────────────────────────
// Same set as sql/25's aa_tasks_set_not_charged trigger, minus jobs the user removed / a cancelled batch dropped
// (they were never attempted, so they are not "not charged" outcomes worth showing).
export const NOT_CHARGED_STATUSES = ["skipped", "failed", "needs_you"];

export function notChargedGroup(t) {
  const code = String(t.reason_code || "").toLowerCase();
  if (/captcha|bot_check|turnstile|hcaptcha|recaptcha/.test(code)) return "captcha";
  if (/block|sso|login|signin|sign_in|forbidden|denied|rate_limit|access/.test(code)) return "blocked";
  if (t.status === "failed") return "failed";
  return "other";
}

export function chargeSummary(tasks) {
  const out = { applied: 0, not_charged: 0, in_progress: 0, by_reason: { failed: 0, captcha: 0, blocked: 0, other: 0 } };
  for (const t of tasks || []) {
    if (t.status === "applied") out.applied++;
    else if (NOT_CHARGED_STATUSES.includes(t.status)) {
      out.not_charged++;
      out.by_reason[notChargedGroup(t)]++;
    } else if (!["removed", "cancelled"].includes(t.status)) out.in_progress++;
  }
  return out;
}

// ── confirmation mail ───────────────────────────────────────────────────────
const BEFORE_MS = 10 * 60 * 1000;
const AFTER_MS = 3 * 86400 * 1000;

/** @returns {Map<taskId, mail>} each mail confirms at most one task (the nearest submit before it). */
export function matchConfirmationMails(tasks, mails) {
  const applied = (tasks || [])
    .filter((t) => t.status === "applied" && t.submitted_at && t.company)
    .map((t) => ({ t, at: Date.parse(t.submitted_at) }))
    .filter((x) => !Number.isNaN(x.at));
  const out = new Map();
  const sorted = [...(mails || [])]
    .filter((m) => m.category === "received" && m.company && m.received_at)
    .sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));
  for (const m of sorted) {
    const at = Date.parse(m.received_at);
    let best = null;
    for (const x of applied) {
      if (out.has(x.t.id) || !sameCompany(x.t.company, m.company)) continue;
      const d = at - x.at;
      if (d < -BEFORE_MS || d > AFTER_MS) continue;
      if (!best || Math.abs(d) < Math.abs(at - best.at)) best = x;
    }
    if (best) out.set(best.t.id, m);
  }
  return out;
}

// ── role families ───────────────────────────────────────────────────────────
const FAMILIES = [
  ["engineering_manager", /\b(engineering|development|software) manager\b|\bhead of engineering\b|\bvp,? engineering\b|\bdirector,? engineering\b/],
  ["product_manager", /\bproduct (manager|owner|lead)\b|\b(apm|tpm)\b|\bprogram manager\b/],
  ["design", /\b(designer|design lead|ux|ui\/ux|user experience|user researcher)\b/],
  ["ml_ai", /\b(machine learning|ml|ai|deep learning|nlp|computer vision|llm|genai|applied scientist|research scientist)\b/],
  ["data", /\b(data (scientist|analyst|engineer|science)|analytics|business intelligence|bi developer|etl|big data)\b/],
  ["devops_sre", /\b(devops|sre|site reliability|platform engineer|infrastructure|cloud engineer|kubernetes|devsecops)\b/],
  ["security", /\b(security|appsec|penetration|infosec|soc analyst)\b/],
  ["qa", /\b(qa|quality assurance|sdet|test(ing)? engineer|automation tester|tester)\b/],
  ["mobile", /\b(android|ios|mobile|flutter|react native)\b/],
  ["embedded", /\b(embedded|firmware|hardware|vlsi|fpga|asic)\b/],
  ["fullstack", /\b(full[ -]?stack)\b/],
  ["frontend", /\b(front[ -]?end|ui engineer|ui developer|react|angular|vue)\b/],
  ["backend", /\b(back[ -]?end|server[- ]side|api engineer|java|golang|python developer|node(\.js)?|\.net|ruby|php)\b/],
  ["software", /\b(software|sde|swe|developer|programmer|engineer)\b/],
];

export const ROLE_FAMILY_LABELS = {
  engineering_manager: "Engineering management",
  product_manager: "Product / program management",
  design: "Design",
  ml_ai: "ML / AI",
  data: "Data",
  devops_sre: "DevOps / SRE / infra",
  security: "Security",
  qa: "QA / test",
  mobile: "Mobile",
  embedded: "Embedded / hardware",
  fullstack: "Full stack",
  frontend: "Frontend",
  backend: "Backend",
  software: "Software (general)",
  other: "Other",
};

export function roleFamily(title) {
  const t = String(title || "").toLowerCase();
  for (const [fam, re] of FAMILIES) if (re.test(t)) return fam;
  return "other";
}

// ── reply rates ─────────────────────────────────────────────────────────────
export const STATS_WINDOW_DAYS = 90;
// replies = any mail that is not an automatic receipt; 'code' (verification codes the apply flow itself
// triggered) is not a reply either
const REPLY_CATEGORIES = ["rejected", "important", "other"];

const rate = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

/**
 * tasks: applied aa_tasks rows {id, company, title, submitted_at}; mails: aa_mail_events {id, company, category, kind,
 * received_at}; interviews: aa_interviews {mail_event_id, company}. Each reply mail is attributed to the user's latest
 * applied task at that company submitted before the mail (else the earliest one after it); a task counts as replied /
 * interviewed / rejected once, so every rate is between 0 and 100 %.
 */
export function replyStats({ tasks = [], mails = [], interviews = [], now = new Date(), windowDays = STATS_WINDOW_DAYS } = {}) {
  const since = now.getTime() - windowDays * 86400000;
  const applied = tasks
    .filter((t) => t.status === undefined || t.status === "applied")
    .map((t) => ({ ...t, at: Date.parse(t.submitted_at), key: companyKey(t.company), family: roleFamily(t.title) }))
    .filter((t) => !Number.isNaN(t.at) && t.at >= since && t.key);
  const byKey = new Map();
  for (const t of applied) {
    if (!byKey.has(t.key)) byKey.set(t.key, []);
    byKey.get(t.key).push(t);
  }
  for (const list of byKey.values()) list.sort((a, b) => a.at - b.at);

  const interviewMail = new Set(interviews.map((i) => i.mail_event_id));
  const flags = new Map(); // task id -> {reply, interview, rejection}
  const findTask = (company, at) => {
    const k = companyKey(company);
    let list = k && byKey.get(k);
    if (!list) {
      const alt = [...byKey.keys()].find((key) => sameCompany(key, k));
      list = alt ? byKey.get(alt) : null;
    }
    if (!list || !list.length) return null;
    const before = list.filter((t) => t.at <= at);
    return before.length ? before[before.length - 1] : list[0];
  };
  for (const m of mails) {
    if (!REPLY_CATEGORIES.includes(m.category) || !m.company) continue;
    const at = Date.parse(m.received_at);
    if (Number.isNaN(at) || at < since) continue;
    const t = findTask(m.company, at);
    if (!t) continue;
    const f = flags.get(t.id) || { reply: false, interview: false, rejection: false };
    f.reply = true;
    if (m.kind === "interview" || interviewMail.has(m.id)) f.interview = true;
    if (m.category === "rejected" || m.kind === "rejection") f.rejection = true;
    flags.set(t.id, f);
  }

  const bump = (map, key, label, t) => {
    const row = map.get(key) || { key, label, applied: 0, replies: 0, interviews: 0, rejections: 0 };
    const f = flags.get(t.id);
    row.applied++;
    if (f && f.reply) row.replies++;
    if (f && f.interview) row.interviews++;
    if (f && f.rejection) row.rejections++;
    map.set(key, row);
  };
  const companies = new Map();
  const roles = new Map();
  const totals = { applied: 0, replies: 0, interviews: 0, rejections: 0 };
  for (const t of applied) {
    bump(companies, t.key, String(t.company).trim(), t);
    bump(roles, t.family, ROLE_FAMILY_LABELS[t.family] || t.family, t);
    const f = flags.get(t.id);
    totals.applied++;
    if (f && f.reply) totals.replies++;
    if (f && f.interview) totals.interviews++;
    if (f && f.rejection) totals.rejections++;
  }
  const finish = (rows) =>
    [...rows.values()]
      .map((r) => ({ ...r, rate: rate(r.replies, r.applied), interview_rate: rate(r.interviews, r.applied) }))
      .sort((a, b) => b.applied - a.applied || b.rate - a.rate || a.label.localeCompare(b.label));
  return {
    window_days: windowDays,
    since: new Date(since).toISOString(),
    totals: { ...totals, rate: rate(totals.replies, totals.applied), interview_rate: rate(totals.interviews, totals.applied) },
    by_company: finish(companies),
    by_role: finish(roles),
  };
}

/**
 * Mail categories, kinds and retention. Pure.
 *   code       verification code / OTP / verify-your-email / password reset      -> kept
 *   received   automated "we received your application / applied successfully"   -> deleted 30 days after receipt
 *   rejected   clear rejection ("unfortunately ... not moving forward", "position has been filled")
 *                                                                                 -> deleted 30 days after receipt
 *   important  assessment / test / interview / offer / next steps / person-written -> kept
 *   other      everything else                                                   -> kept
 * Only received and rejected are ever deleted, so they are chosen only when clearly matched; a rejection that
 * also invites to an interview / assessment / offer is not a rejection. Anything unsure is kept.
 *
 * kind (finer label, for filters and notifications):
 *   interview | assessment | offer | recruiter  (category important), rejection (category rejected), null otherwise.
 */
export const RETENTION_DAYS = { code: null, received: 30, rejected: 30, important: null, other: null };
export const CATEGORIES = Object.keys(RETENTION_DAYS);
export const KINDS = ["interview", "assessment", "offer", "recruiter", "rejection"];
/** Categories that alert the user (push + daily digest + unread badge). */
export const NOTIFY_CATEGORIES = ["important", "rejected"];

const STRONG_IMPORTANT = [
  /\bassessments?\b/i, /\bcoding (test|challenge|round|exercise)\b/i, /\b(online|technical|aptitude|skills?|hiring) (test|challenge|round)\b/i,
  /\b(hackerrank|codility|codesignal|hirevue|mettl|devskiller|testgorilla|coderpad|shl|cocubes|eightfold)\b/i,
  /\binterviews?\b/i, /\boffer (letter|of employment)\b/i, /\bjob offer\b/i, /\bpleased to offer\b/i,
  /\bschedule (a|your) (call|interview|meeting|discussion)\b/i, /\b(video|phone|telephonic) (call|screen|interview)\b/i,
  /\bwe would like to (invite|speak|talk|meet)\b/i,
];
const WEAK_IMPORTANT = [
  /\bnext steps?\b/i, /\bshortlisted\b/i, /\b(move|moving) (you )?forward\b/i, /\bwe'?d like to\b/i, /\brecruiter\b/i,
  /\bselected for\b/i, /\bcongratulations\b/i, /\bavailability\b/i, /\bhiring manager\b/i,
];
const CODE_SUBJECT = [
  /\bverify your (e-?mail|account|identity)\b/i, /\b(e-?mail|account) verification\b/i, /\bverification (code|pin|link)\b/i,
  /\bverify (this|the) (e-?mail|code)\b/i, /\bone[- ]time (pass(word|code)|code|pin)\b/i, /\botp\b/i, /\b(security|confirmation|login|sign[- ]?in|access) code\b/i,
  /\breset (your )?password\b/i, /\bpassword reset\b/i, /\bactivate your account\b/i, /\bconfirm your (email|account)\b/i,
];
const CODE_BODY = [/\b(verification|security|confirmation|one[- ]time|login) (code|pin)\b/i, /\botp\b/i, /\bverify your (email|account)\b/i];
const RECEIVED = [
  /\b(we(?:'ve| have)?|has been) received your (job )?application\b/i, /\bapplication (has been )?(received|submitted)\b/i,
  /\bthank(s| you) for (applying|your (interest|application))\b/i, /\byour application (to|for|with)\b.*\b(was|has been) (received|submitted)\b/i,
  /\bapplication confirmation\b/i, /\bthank(s| you) for applying\b/i, /\bwe got your application\b/i,
  /\byou(?:'ve| have)? (successfully )?applied (successfully )?(to|for)\b/i, /\bapplication (was )?(submitted )?successful(ly)?\b/i,
  /\bsuccessfully (applied|submitted)\b/i, /\bapplied successfully\b/i,
];

// Clear rejection phrases. "Unfortunately" alone is not enough (an expired link is "unfortunately" too).
const REJECT = [
  /\bnot (be )?(moving|move|proceed(ing)?|progress(ing)?|advanc(e|ing)|going) forward\b[^.\n]{0,40}\b(application|candidacy|profile|you)\b/i,
  /\bnot (be )?(proceed(ing)?|progress(ing)?) (further )?with (your|the) (application|candidacy|profile)\b/i,
  /\b(decided|chosen|elected|opted) (not to (move|go) forward|not to proceed|not to progress|to (move|go) forward with (other|another|a different)|to proceed with (other|another)|to pursue (other|another))\b/i,
  /\bpursue other (candidates?|applicants?|profiles?)\b/i,
  /\b(move|moving|go|going|proceed|proceeding) forward with (other|another|a different) (candidates?|applicants?|profiles?)\b/i,
  /\b(proceed|proceeding|progress|progressing) with (other|another|different) (candidates?|applicants?|profiles?)\b/i,
  /\b(position|role|job|vacancy|opening|requisition) (has|have) (now )?been (filled|closed|cancell?ed)\b/i,
  /\b(will|would) not be (proceeding|moving forward|progressing|taking (your|this) application|considering your application)\b/i,
  /\bwon'?t be (proceeding|moving forward|progressing)\b/i,
  /\bregret to (inform|advise|let you know)\b/i,
  /\bunable to (offer you|move forward|proceed|progress|take your application)\b/i,
  /\b(you )?(have|has|were|was) not (been )?(selected|shortlisted|successful)\b/i,
  /\bapplication (was|has been|is) unsuccessful\b/i, /\bnot successful (this time|on this occasion)\b/i,
  /\b(other|another) candidates? whose (qualifications|experience|skills|background|profiles?)\b/i,
  /\bno longer (being )?(consider(ed|ing)|under consideration)\b/i,
];
const UNFORTUNATELY = /\bunfortunately\b[^]{0,240}?\b(not|unable|no longer|won'?t|cannot|can'?t|other candidates?)\b/i;
const APP_CONTEXT = /\b(application|candidacy|position|role|opportunity|applicants?|candidates?)\b/i;
// Forward-looking invitations: when present the mail is NOT treated as a rejection (it is kept).
const INVITE = [
  /\b(invite|invitation|inviting)\b[^.\n]{0,30}\b(to|for)\b[^.\n]{0,20}\b(interview|call|chat|assessment|test|challenge|next round|onsite|on-site|conversation|discussion|meeting)\b/i,
  /\bschedule (a|an|your|the) (call|interview|meeting|time|chat|conversation)\b/i,
  /\b(share|send|provide|let us know|confirm) your availability\b/i,
  /\bpleased to (offer|extend|invite)\b/i, /\boffer (letter|of employment)\b/i, /\bjob offer\b/i,
  /\b(complete|take|attempt|start) (the|this|your|an|a) (online |coding |technical )?(assessment|test|challenge)\b/i,
  /(zoom\.us\/j|meet\.google\.com\/[a-z]|teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com\/meet)/i,
  /\b(move|moving) (you )?forward to the next (round|stage|step)\b/i,
];

const OFFER_RE = [/\boffer (letter|of employment)\b/i, /\bjob offer\b/i, /\bpleased to (offer|extend (you )?an offer)\b/i];
const ASSESS_RE = [
  /\bassessments?\b/i, /\bcoding (test|challenge|round|exercise)\b/i, /\b(online|technical|aptitude|skills?|hiring) (test|challenge)\b/i,
  /\b(hackerrank|codility|codesignal|hirevue|mettl|devskiller|testgorilla|shl|cocubes|hackerearth)\b/i, /\btake[- ]home\b/i,
];
const MEETING_RE = /(zoom\.us\/j|meet\.google\.com\/[a-z]|teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com\/meet|webex\.com\/(meet|join))/i;
const INTERVIEW_RE = [/\binterview(s|ing)?\b/i, /\bschedule (a|your) (call|meeting|discussion)\b/i, /\b(video|phone|telephonic) (call|screen)\b/i];

const any = (list, s) => list.some((re) => re.test(s));

/** True for a clear rejection that does not also invite to an interview / assessment / offer. */
export function isRejection(all) {
  if (any(INVITE, all)) return false;
  if (any(REJECT, all)) return true;
  return UNFORTUNATELY.test(all) && APP_CONTEXT.test(all);
}

function importantKind(subject, all, isHuman, hasIcs) {
  if (any(OFFER_RE, subject)) return "offer";
  if (any(ASSESS_RE, subject)) return "assessment";
  if (any(INTERVIEW_RE, subject)) return "interview";
  if (any(OFFER_RE, all)) return "offer";
  if (hasIcs || MEETING_RE.test(all)) return "interview";   // meeting link / calendar invite
  if (any(ASSESS_RE, all)) return "assessment";
  if (any(INTERVIEW_RE, all)) return "interview";
  if (isHuman || /\brecruiter\b/i.test(all)) return "recruiter";
  return null;
}

/**
 * @param {{subject?: string, text_excerpt?: string, text?: string, codes?: string[], is_human?: boolean, ics?: string|null, meeting_links?: string[]}} m
 * @returns {{category: 'code'|'received'|'rejected'|'important'|'other', kind: string|null, retention_days: number|null}}
 */
export function classifyMail(m = {}) {
  const subject = String(m.subject || "");
  const body = String(m.text_excerpt ?? m.text ?? "");
  const head = body.slice(0, 400);
  const meeting = Array.isArray(m.meeting_links) ? m.meeting_links.join("\n") : "";
  const all = `${subject}\n${body}\n${meeting}`;
  const isHuman = m.is_human === true;
  const codes = Array.isArray(m.codes) ? m.codes : [];
  const hasIcs = typeof m.ics === "string" && /BEGIN:VEVENT/i.test(m.ics);

  let category;
  if (!hasIcs && isRejection(all)) category = "rejected";
  else if (hasIcs || any(STRONG_IMPORTANT, all)) category = "important";
  else if (!isHuman && (any(RECEIVED, subject) || any(RECEIVED, head))) category = "received";
  else if (!isHuman && any(WEAK_IMPORTANT, all)) category = "important";
  else if (!isHuman && (any(CODE_SUBJECT, subject) || (codes.length > 0 && any(CODE_BODY, all)))) category = "code";
  else if (isHuman) category = "important";
  else category = "other";
  const kind = category === "rejected" ? "rejection" : category === "important" ? importantKind(subject, all, isHuman, hasIcs) : null;
  return { category, kind, retention_days: RETENTION_DAYS[category] ?? null };
}

/** ISO expiry for a category, or null when the mail is never deleted. */
export function expiresAtFor(category, receivedAt = new Date()) {
  const days = RETENTION_DAYS[category];
  if (days == null) return null;
  return new Date(new Date(receivedAt).getTime() + days * 86_400_000).toISOString();
}

// ── company name from a mail ───────────────────────────────────────────────
const GENERIC_LABELS = new Set([
  "com", "in", "co", "org", "net", "io", "ai", "uk", "us", "mail", "email", "careers", "career", "jobs", "talent", "hr", "notifications",
  "myworkday", "myworkdayjobs", "myworkdaysite", "workday", "greenhouse", "greenhouse-mail", "lever", "hire", "smartrecruiters", "icims", "taleo",
  "successfactors", "sapsf", "oraclecloud", "oracle", "ashbyhq", "jobvite", "eightfold", "phenompeople", "hackerrank", "hirevue", "codility",
  "codesignal", "mettl", "linkedin", "indeed", "naukri", "sendgrid", "amazonses", "mailgun", "noreply", "no-reply", "recruiting", "apply",
]);
const GENERIC_NAME = /^(?:no[- ]?reply|do[- ]?not[- ]?reply|workday|greenhouse|lever|smartrecruiters|icims|taleo|successfactors|oracle|ashby|jobvite|hackerrank|hirevue|codility|codesignal|mettl|linkedin|indeed|naukri|notifications?|careers?|jobs?|recruiting|talent acquisition|hr|hiring team|the hiring team|recruitment team|team)$/i;
const NAME_SUFFIX = /\s*(?:[-|,@]\s*)?\b(?:careers?|jobs?|recruiting|recruitment|talent(?: acquisition)?(?: team)?|hiring(?: team)?|hr(?: team)?|people(?: team)?|university recruiting|via [a-z]+|team|notifications?|no[- ]?reply)\s*$/i;
const PERSON_NAME = /^[A-Z][a-z]+(?: [A-Z]\.?)?(?: [A-Z][a-z'-]+)$/;   // "Jane Doe": a person, not a company

const titleCase = (s) => s.replace(/\b([a-z])/g, (c) => c.toUpperCase());

/** Best guess of the company a mail is from: display name, then "at/with/to <Company>" in the subject, then the sender domain. */
export function companyFromMail({ sender = "", from_name = "", subject = "" } = {}) {
  let name = String(from_name || "").replace(/["<>]/g, "").trim();
  for (let i = 0; i < 3 && NAME_SUFFIX.test(name); i++) name = name.replace(NAME_SUFFIX, "").trim();
  const personal = PERSON_NAME.test(name) || /\b(?:at|from)\b/i.test(name);
  if (/\b(?:at|from)\s+(.+)$/i.test(name)) {
    const c = /\b(?:at|from)\s+(.+)$/i.exec(name)[1].replace(NAME_SUFFIX, "").trim();   // "Jane at Acme" -> Acme
    if (c && !GENERIC_NAME.test(c)) return c.slice(0, 80);
  }
  if (name && !personal && !GENERIC_NAME.test(name) && !/@/.test(name) && name.length <= 60) return name;

  const subj = String(subject || "");
  const m = /\b(?:at|with|to|from)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/.exec(subj);
  if (m) {
    const c = m[1].replace(/[.,!:;]+$/, "").trim();
    if (c && !GENERIC_NAME.test(c)) return c.slice(0, 80);
  }

  const d = /@([^>\s]+)/.exec(String(sender || ""));
  if (!d) return null;
  const parts = d[1].toLowerCase().split(".").filter(Boolean);
  const pick = [...parts].reverse().find((p) => !GENERIC_LABELS.has(p) && p.length > 1);
  return pick ? titleCase(pick) : null;
}

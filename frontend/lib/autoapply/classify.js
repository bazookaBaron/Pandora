/**
 * Mail categories, kinds and retention. Pure.
 *   code       verification code / OTP / verify-your-email / password reset      -> deleted 7 days after receipt
 *   received   automated "we received your application / applied successfully"   -> deleted 30 days after receipt
 *   rejected   clear rejection ("unfortunately ... not moving forward", "position has been filled")
 *                                                                                 -> deleted 30 days after receipt
 *   important  assessment / test / interview / offer / next steps / person-written -> kept
 *   other      everything else                                                   -> kept
 * Mail to an unknown alias (no user) is deleted 3 days after receipt, whatever its category.
 * Unauthenticated mail (auth_ok false: no DMARC / aligned DKIM pass) is low-trust: never 'code' (its codes and
 * links are not stored, so no task can use them), flagged low_trust.
 * Of the user's mail, only codes, received and rejected are ever deleted, so they are chosen only when clearly matched; a rejection that
 * also invites to an interview / assessment / offer is not a rejection. Anything unsure is kept.
 *
 * kind (finer label, for filters and notifications):
 *   interview | assessment | offer | recruiter  (category important), rejection (category rejected), null otherwise.
 */
export const RETENTION_DAYS = { code: 7, received: 30, rejected: 30, important: null, other: null };
export const CATEGORIES = Object.keys(RETENTION_DAYS);
/** Mail to an alias no user owns (user_id NULL) is kept this long, whatever its category. */
export const UNKNOWN_ALIAS_DAYS = 3;
export const KINDS = ["interview", "assessment", "offer", "recruiter", "rejection"];
/** Categories that alert the user (push + daily digest + unread badge). */
export const NOTIFY_CATEGORIES = ["important", "rejected"];

/** Candidate kinds that must be confirmed by corroborating evidence before they are saved (stage 2, confirmKind). */
export const VERIFY_KINDS = ["interview", "assessment", "offer"];

// Hard evidence: a calendar invite, a meeting link or a link to an assessment platform. It wins even over a
// "thank you for applying" opener, because the link itself is the invitation.
const ASSESS_LINK_RE = /https?:\/\/[^\s"'<>]*\b(hackerrank\.com|codility\.com|codesignal\.com|hirevue\.com|mettl\.com|devskiller\.com|testgorilla\.com|coderpad\.io|hackerearth\.com|shl\.com|cocubes\.com|karat\.com|vervoe\.com|criteriacorp\.com|imocha\.io|glider\.ai)\b[^\s"'<>]*/i;
// Unambiguous textual cues. NOT a bare "interview" / "assessment" / "availability" / "next steps": those appear in
// "thank you for applying ... we will contact you to arrange an interview" boilerplate.
const STRONG_IMPORTANT = [
  /\bschedule (a|your|an) (interview|call|meeting|discussion)\b/i, /\binvite (you )?to (an? )?(interview|assessment|coding (test|challenge)|technical (round|test|screen))\b/i,
  /\b(interview|assessment|coding challenge|test) (invitation|invite)\b/i, /\binvited (you )?to (an? )?(interview|complete|take|attempt)\b/i,
  /\b(complete|take|attempt|start|begin) (the|this|your|an|a) (online |coding |technical |hackerrank |skills? )?(assessment|test|challenge)\b/i,
  /\b(link to|access) (the|your) (online |coding |technical )?(assessment|test)\b/i, /\bcoding (test|challenge|round|exercise)\b/i,
  /\b(online|technical|aptitude|hiring) (test|challenge)\b/i, /\btake[- ]home (test|assignment|assessment|challenge|exercise)\b/i,
  /\boffer (letter|of employment)\b/i, /\bjob offer\b/i, /\bpleased to (offer|extend (you )?an offer)\b/i,
  /\b(video|phone|telephonic) (call|screen|interview)\b/i, /\bwe would like to (invite|speak|talk|meet)\b/i,
];
// Soft signals keep a mail (category important, never deleted) but name no kind and never create an interview row.
const WEAK_IMPORTANT = [
  /\binterviews?\b/i, /\bassessments?\b/i, /\b(hackerrank|codility|codesignal|hirevue|mettl|devskiller|testgorilla|coderpad|shl|cocubes|eightfold)\b/i,
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
  /\bcoding (test|challenge|round|exercise)\b/i, /\b(online|technical|aptitude|skills?|hiring) (test|challenge)\b/i,
  /\b(complete|take|attempt|start|begin) (the|this|your|an|a) [a-z ]{0,25}(assessment|test|challenge)\b/i, /\b(link to|access) (the|your) [a-z ]{0,20}(assessment|test)\b/i,
  /\b(assessment|test) (invitation|invite)\b/i, /\btake[- ]home (test|assignment|assessment|challenge|exercise)\b/i,
];
const MEETING_RE = /(zoom\.us\/(j|my)|meet\.google\.com\/[a-z]|teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com\/meet|webex\.com\/(meet|join)|calendly\.com\/|goodtime\.io\/|savvycal\.com\/|cal\.com\/|gotomeet\.me\/|chilipiper\.com\/)/i;
// Stage 2 evidence
const INTERVIEW_CONFIRM = [
  /\bschedule (a|your|an|the) (interview|call with)\b/i, /\binvite you to (an? )?(interview|technical (round|screen))\b/i, /\binvited (you )?to (an? )?interview\b/i,
  /\binterview (is |has been |was )?(scheduled|confirmed)\b/i, /\b(select|pick|choose|book|reserve) (a|your|an) (time|slot|date)\b/i, /\binterview (invitation|invite)\b/i,
];
const ASSESS_CONFIRM = /\b(complete|take|attempt|start|begin) (the|this|your|an|a) [a-z ]{0,25}(assessment|test|challenge)\b/i;
const ASSESS_SENDER = /@[a-z0-9.-]*\b(hackerrank|codility|codesignal|hackerearth|mettl|testgorilla|karat|devskiller|hirevue|coderpad|shl|cocubes)\b/i;
const OFFER_CONFIRM = [/\boffer letter\b/i, /\boffer of employment\b/i, /\bpleased to (offer|extend (you )?an offer)\b/i, /\b(extend|extending) (you )?(an|the|our) offer\b/i, /\bjob offer\b/i];
const MARKETING = /\b(unsubscribe|newsletter|view in browser|manage (your )?(email )?preferences|special offer|limited[- ]time|% off|discount|job alerts?|jobs? (near|for) you|recommended jobs?)\b/i;
// Applicant-tracking systems send acknowledgements from no-reply addresses; without hard evidence they are receipts.
const ATS_AUTO = /(no-?reply|donotreply|do-not-reply|notifications?)@|@[a-z0-9.-]*\b(myworkday|workday|greenhouse|lever|smartrecruiters|icims|taleo|successfactors|ashbyhq|jobvite|bamboohr|recruitee|breezy|workable|teamtailor)\b/i;

/** Stage 2: does corroborating evidence back the candidate kind? Pure. */
export function confirmKind(kind, { all, sender, hasIcs, isReceived, isHuman }) {
  const hasMeeting = MEETING_RE.test(all);
  const hasAssessLink = ASSESS_LINK_RE.test(all);
  const atsAuto = !isHuman && ATS_AUTO.test(sender);
  const textOk = !isReceived && !atsAuto;   // phrase-only evidence is not enough on an auto-acknowledgement
  if (kind === "interview") return hasIcs || hasMeeting || (textOk && any(INTERVIEW_CONFIRM, all));
  if (kind === "assessment") return hasAssessLink || ASSESS_SENDER.test(sender) || (textOk && ASSESS_CONFIRM.test(all) && /https?:\/\//i.test(all));
  if (kind === "offer") return textOk && any(OFFER_CONFIRM, all) && !MARKETING.test(all);
  return true;
}
const INTERVIEW_RE = [
  /\bschedule (a|your|an) (interview|call|meeting|discussion)\b/i, /\binvite (you )?to (an? )?(interview|technical (round|screen))\b/i, /\binterview (invitation|invite)\b/i,
  /\binvited (you )?to (an? )?interview\b/i, /\b(video|phone|telephonic) (call|screen|interview)\b/i, /\bwe would like to (invite|speak|talk|meet)\b/i,
];

const any = (list, s) => list.some((re) => re.test(s));

/** True for a clear rejection that does not also invite to an interview / assessment / offer. */
export function isRejection(all) {
  if (any(INVITE, all)) return false;
  if (any(REJECT, all)) return true;
  return UNFORTUNATELY.test(all) && APP_CONTEXT.test(all);
}

function importantKind(subject, all, isHuman, hasIcs, hasAssessLink = false) {
  if (any(OFFER_RE, subject)) return "offer";
  if (any(ASSESS_RE, subject) || hasAssessLink) return "assessment";
  if (any(INTERVIEW_RE, subject)) return "interview";
  if (any(OFFER_RE, all)) return "offer";
  if (hasIcs || MEETING_RE.test(all)) return "interview";   // meeting link / calendar invite
  if (any(ASSESS_RE, all)) return "assessment";
  if (any(INTERVIEW_RE, all)) return "interview";
  if (isHuman || /\brecruiter\b/i.test(all)) return "recruiter";
  return null;
}

/**
 * @param {{subject?: string, text_excerpt?: string, text?: string, codes?: string[], is_human?: boolean, ics?: string|null, meeting_links?: string[], auth_ok?: boolean}} m
 * @returns {{category: 'code'|'received'|'rejected'|'important'|'other', kind: string|null, retention_days: number|null, low_trust: boolean}}
 */
export function classifyMail(m = {}) {
  const subject = String(m.subject || "");
  const body = String(m.text_excerpt ?? m.text ?? "");
  const head = body.slice(0, 400);
  const meeting = Array.isArray(m.meeting_links) ? m.meeting_links.join("\n") : "";
  const links = Array.isArray(m.links) ? m.links.join("\n") : "";
  const all = `${subject}\n${body}\n${meeting}\n${links}`;
  const isHuman = m.is_human === true;
  const codes = Array.isArray(m.codes) ? m.codes : [];
  const hasIcs = typeof m.ics === "string" && /BEGIN:VEVENT/i.test(m.ics);
  const lowTrust = m.auth_ok === false;

  const hardEvidence = hasIcs || MEETING_RE.test(all) || ASSESS_LINK_RE.test(all);
  const isReceived = !isHuman && (any(RECEIVED, subject) || any(RECEIVED, head));

  let category;
  if (!hasIcs && isRejection(all)) category = "rejected";
  else if (hardEvidence) category = "important";
  else if (isReceived) category = "received";   // before STRONG: "thank you for applying ... we will arrange an interview" is a receipt
  else if (any(STRONG_IMPORTANT, all)) category = "important";
  else if (!isHuman && any(WEAK_IMPORTANT, all)) category = "important";
  else if (!isHuman && (any(CODE_SUBJECT, subject) || (codes.length > 0 && any(CODE_BODY, all)))) category = lowTrust ? "other" : "code";
  else if (isHuman) category = "important";
  else category = "other";
  let kind = category === "rejected" ? "rejection" : category === "important" ? importantKind(subject, all, isHuman, hasIcs, ASSESS_LINK_RE.test(all)) : null;
  // Stage 2: an interview / assessment / offer candidate is saved only with corroborating evidence.
  let kind_source = null;
  if (VERIFY_KINDS.includes(kind)) {
    const sender = String(m.sender || "");
    if (confirmKind(kind, { all, sender, hasIcs, isReceived, isHuman })) kind_source = "rule_confirmed";
    else {
      kind_source = "rule_weak";
      if (isHuman) { category = "important"; kind = "recruiter"; }
      else if (isReceived || ATS_AUTO.test(sender)) { category = "received"; kind = null; }
      else kind = null;   // keep the mail (important, never deleted) but name no kind and create no interview row
    }
  }
  return { category, kind, kind_source, retention_days: RETENTION_DAYS[category] ?? null, low_trust: lowTrust };
}

/** ISO expiry for a category, or null when the mail is never deleted. */
export function expiresAtFor(category, receivedAt = new Date()) {
  const days = RETENTION_DAYS[category];
  if (days == null) return null;
  return new Date(new Date(receivedAt).getTime() + days * 86_400_000).toISOString();
}

/** ISO expiry for one stored mail: unknown alias (user_id null) -> 3 days, else by category (null = kept). */
export function mailExpiresAt({ category, user_id } = {}, receivedAt = new Date()) {
  if (user_id === null || user_id === undefined) return new Date(new Date(receivedAt).getTime() + UNKNOWN_ALIAS_DAYS * 86_400_000).toISOString();
  return expiresAtFor(category, receivedAt);
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

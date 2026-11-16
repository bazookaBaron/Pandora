/**
 * Mail categories and retention. Pure.
 *   code       verification code / OTP / verify-your-email / password reset      -> 1 day
 *   received   automated "we received your application / thank you for applying" -> 14 days
 *   important  assessment / test / interview / offer / next steps / person-written -> 180 days
 *   other      everything else                                                   -> 180 days
 * code and received are deleted early, so they are chosen only when clearly matched.
 * Anything unsure falls to important/other.
 */
export const RETENTION_DAYS = { code: 1, received: 14, important: 180, other: 180 };
export const CATEGORIES = Object.keys(RETENTION_DAYS);

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
];

const any = (list, s) => list.some((re) => re.test(s));

/**
 * @param {{subject?: string, from?: string, text_excerpt?: string, text?: string, codes?: string[], is_human?: boolean}} m
 * @returns {{category: 'code'|'received'|'important'|'other', retention_days: number}}
 */
export function classifyMail(m = {}) {
  const subject = String(m.subject || "");
  const body = String(m.text_excerpt ?? m.text ?? "");
  const head = body.slice(0, 400);
  const all = `${subject}\n${body}`;
  const isHuman = m.is_human === true;
  const codes = Array.isArray(m.codes) ? m.codes : [];

  let category;
  if (any(STRONG_IMPORTANT, all)) category = "important";
  else if (!isHuman && (any(RECEIVED, subject) || any(RECEIVED, head))) category = "received";
  else if (!isHuman && any(WEAK_IMPORTANT, all)) category = "important";
  else if (!isHuman && (any(CODE_SUBJECT, subject) || (codes.length > 0 && any(CODE_BODY, all)))) category = "code";
  else if (isHuman) category = "important";
  else category = "other";
  return { category, retention_days: RETENTION_DAYS[category] };
}

export function expiresAtFor(category, receivedAt = new Date()) {
  const days = RETENTION_DAYS[category] ?? RETENTION_DAYS.other;
  return new Date(new Date(receivedAt).getTime() + days * 86_400_000).toISOString();
}

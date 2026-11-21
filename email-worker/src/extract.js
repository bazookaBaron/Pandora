// Pure extraction helpers for the AutoApply inbound mail worker.
//
// Port of AutoJobApplier/cloud_hunter/mail_otp.py (CODE_RE, LINK_RE, VERIFY_HINT, find_code, the
// <style>/<script>/<head> strip, the link skip list), extended for one difference: the bot knew which
// site and code length it was waiting for, this worker does not. So instead of "the first match" it
// returns every plausible candidate in document order and filters harder against numbers that are not
// codes (prices, phone numbers, dates, years, job ids, zip codes, promo codes). The Python worker that
// consumes aa_mail_events still picks by sender / tenant / length.

export const MAX_BYTES = 10 * 1024 * 1024;

// --- verbatim from mail_otp.py --------------------------------------------------------------------
export const CODE_RE = /(?<![\d#])(\d{4,8})(?!\d)/g;
export const LINK_RE = /https?:\/\/[^\s"'<>]+/gi;
export const VERIFY_HINT = /verif|activate|confirm|validate|code|otp|one[- ]time|sign[- ]?in/i;
const PY_LINK_SKIP = ['unsubscribe', 'privacy', 'logo', '.png', '.jpg', 'mailto:'];

// --- additions --------------------------------------------------------------------------------------
// a word that introduces a code ("verification code", "passcode", "OTP", "PIN")
const CUE_RE = /\b(?:code|otp|passcode|pass code|pin)\b|one[- ]time/gi;
// "<word> code" that is NOT a verification code
const NEG_CUE_RE = /(?:promo(?:tional)?|discount|coupon|voucher|referral|gift|zip|postal|pin|area|country|dial(?:ling)?|source|qr|bar|dress|tax|swift|ifsc|sort|ref(?:erral)?|offer|bonus|invite|invitation)\s*[- ]?$/i;
// the mail as a whole is about verifying / signing in (needed before an alphanumeric token is trusted)
const STRONG_CONTEXT = /verif|one[- ]time|security code|passcode|\botp\b|sign[- ]?in|log[- ]?in|confirm (?:your )?(?:e-?mail|account|identity)|authenticat/i;
// what follows a promo code
const PROMO_AFTER = /^\s*(?:at checkout|for \d|to (?:get|save|receive|claim|unlock)|and (?:get|save)|off\b|during checkout)/i;
// words right before a number that make it a non-code
const NOISE_BEFORE = /(?:^|[^A-Za-z])(?:phone|tel|telephone|call(?: us)?|fax|mobile|cell|whatsapp|sms|text us|dial|order|invoice|receipt|ticket|case|ref|reference|zip(?: code)?|postal(?: code)?|pin ?code|suite|ste|room|floor|unit|apt|building|p\.?o\.? box|box|copyright|©|job|req|requisition|posting|position|id|no|num|number|ext|extension|version|build|account(?: number)?|a\/c|employee|batch|route|flight|seat|gate|rank|step|page)\s*(?:at|on|is|no\.?|number|id|#)?\s*[:#.\-()]*\s*$/i;
const UNIT_AFTER = /^\s*(?:%|\+|[x×]\s?\d|px|pt|em|rem|k\b|m\b|mb|gb|kb|tb|am\b|pm\b|a\.m|p\.m|hrs?\b|hours?|mins?\b|minutes|secs?\b|seconds|days?\b|weeks?|months?|years?|yrs?\b|users|people|members|employees|engineers|developers|candidates|companies|customers|clients|jobs|openings|roles|views|followers|subscribers|reviews|points|pts\b|miles|km\b|kms\b|sq\b|ft\b|lbs?\b|kg\b|°|inr\b|usd\b|eur\b|gbp\b|rs\b|\/-|lpa\b|lakhs?|crores?|cr\b|words|pages|steps)/i;
const STREET_AFTER = /^\s+(?:[A-Za-z]+\s+){0,3}?(?:street|st|road|rd|avenue|ave|point|pkwy|parkway|blvd|boulevard|lane|ln|drive|dr|way|court|ct|place|pl|highway|hwy|marg|nagar|cross|main|sector|block|layout)\b/i;
const ID_TOKEN = /^(?:[A-Z]{1,4}[-_]?\d{4,}|\d{4,}[A-Z]{1,2})$/;   // R0012345, JR123456, REQ12345: requisition ids
const CURRENCY_BEFORE = /(?:[$€£₹¥¢]|\b(?:rs\.?|inr|usd|eur|gbp|aud|cad|sgd|aed|ctc))\s*$/i;
const YEAR_RE = /^(?:19[5-9]\d|20[0-4]\d)$/;
const ALNUM_RE = /\b[A-Za-z0-9]{6,10}\b/g;
const ALNUM_STOP = new Set(['ACCOUNT', 'BELOW', 'ABOVE', 'EXPIRES', 'MINUTES', 'PLEASE', 'IMPORTANT', 'SECURITY', 'VERIFY',
  'ENTER', 'CANDIDATE', 'APPLICATION', 'CAREERS', 'WORKDAY', 'HELLO', 'THANKS', 'REGARDS', 'CONFIRM', 'NOTICE', 'SUBJECT']);

const SKIP_LINK_EXTRA = /\.(?:gif|jpe?g|png|svg|ico|css|js|woff2?|ttf|webp)(?:[?#]|$)|\/(?:open|pixel|beacon|track\/open)(?:\.gif)?(?:[?/#]|$)|opt[-_]?out|email[-_]?preferences|manage[-_]?(?:subscription|preferences)|code[-_]of[-_]conduct|\/terms\b|\/legal\b|cookie/i;
const STRONG_LINK = /verif|activat|confirm|validat|token=|otp|sign[- ]?in|signin|magic|passwordless|set[-_]?password|reset/i;
export const ATS_HOST_RE = /(?:^|\.)(?:myworkdayjobs\.com|myworkday\.com|myworkdaysite\.com|workday\.com|greenhouse\.io|greenhouse-mail\.io|icims\.com|successfactors\.(?:com|eu)|sapsf\.(?:com|eu|cn)|oraclecloud\.com|taleo\.net|lever\.co|ashbyhq\.com|smartrecruiters\.com|jobvite\.com)$/i;

const MAX_CODES = 5;
const MAX_LINKS = 10;

// ----------------------------------------------------------------------------------------- text utils
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', copy: '©', reg: '®', zwnj: '', zwj: '' };

export function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** HTML -> readable text. Drops <style>/<script>/<head> first (mail_otp.py: Texas Instruments' CSS had
 *  ".containerWidth code {...}" and the first token after "code" was a CSS value). Block ends become
 *  newlines so a code in its own <td>/<div> ends up on its own line. */
export function htmlToText(html) {
  if (!html) return '';
  let s = String(html).replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(?:br|\/p|\/div|\/tr|\/td|\/th|\/li|\/h[1-6]|\/table|\/center|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[​-‍⁠﻿­]/g, '');
  s = s.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** The text the code search runs over: subject + plain body + HTML body as text, URLs removed
 *  (ids inside links are never codes). */
export function codeSearchText(subject, text, html) {
  const body = [text || '', htmlToText(html)].filter(Boolean).join('\n');
  return `${subject || ''}\n${body}`.replace(LINK_RE, ' ');
}

// ---------------------------------------------------------------------------------------------- codes
/** Cue positions ("code", "OTP", "passcode", "one-time"), excluding promo/zip/pin-code style cues. */
function cuePositions(text) {
  const out = [];
  for (const m of text.matchAll(CUE_RE)) {
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    if (NEG_CUE_RE.test(before)) continue;
    // "PIN code" / "zip code": the cue word is "code" but the word before it is negative; a bare "pin"
    // followed by "code" is handled by the "code" occurrence itself
    if (/^pin$/i.test(m[0]) && /^\s*code/i.test(text.slice(m.index + m[0].length, m.index + m[0].length + 6))) continue;
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** True when the number at [start, end) is a price, phone, date, time, year, id, zip, quantity... */
export function isNoiseNumber(text, start, end) {
  const digits = text.slice(start, end);
  const before = text.slice(Math.max(0, start - 40), start);
  const near = before.slice(-14);
  const after = text.slice(end, end + 16);
  if (CURRENCY_BEFORE.test(near)) return true;
  if (/[A-Za-z_]$/.test(before)) return true;                 // R12345, x400, abc1234
  if (/\d[ \t.,/:\-–)]{1,2}$/.test(before)) return true;       // 415-555-0134, 16/11/2026, 98765 43210, 1,299
  if (/[+(]\s*$/.test(before)) return true;                   // +1234 / (1234
  if (/^[.,]\d/.test(after)) return true;                      // 1299.00, 12,999
  if (/^[ \t/:\-–.)]{1,2}\d/.test(after)) return true;          // date / time / spaced phone group
  if (UNIT_AFTER.test(after)) return true;                    // 25000 engineers, 1500px, 10%
  if (PROMO_AFTER.test(after)) return true;
  if (STREET_AFTER.test(after)) return true;                  // 10880 Malibu Point, 1200 Main Street
  if (NOISE_BEFORE.test(before)) return true;                 // Job ID: 12345, call 1800..., Order #
  if (/\b[A-Z]{2}\s$/.test(before) && digits.length === 5) return true;   // US state + zip: CA 94105
  if (digits.length === 4 && YEAR_RE.test(digits) && !/(?:code|otp|passcode|pin)(?:\s+is)?\s*[:\-]?\s*$/i.test(before)) return true;
  return false;
}

function lineAround(text, start, end) {
  const a = text.lastIndexOf('\n', start - 1) + 1;
  let b = text.indexOf('\n', end);
  if (b < 0) b = text.length;
  return text.slice(a, b).trim();
}

/** Numeric codes (CODE_RE). Accepted when not noise and either a cue word sits within 100 chars before
 *  it, the sentence after names it ("482913 is your code"), or it stands alone on its line in a mail
 *  whose subject asks for verification. */
export function findNumericCodes(text, subject = '') {
  const cues = cuePositions(text);
  const subjHint = VERIFY_HINT.test(subject || '');
  const out = [];
  const claimed = new Set();                                 // a cue word introduces one code, not every number after it
  for (const m of text.matchAll(CODE_RE)) {
    const start = m.index, end = start + m[1].length;
    if (isNoiseNumber(text, start, end)) continue;
    const cue = cues.find((c) => c.end <= start && start - c.end <= 100 && !claimed.has(c.start));
    const cueBefore = Boolean(cue);
    const cueAfter = /^\W{0,3}(?:is|was|will be)\s+(?:your|the)\b[^.\n]{0,40}(?:code|otp|passcode|pin)/i.test(text.slice(end, end + 70));
    const alone = subjHint && lineAround(text, start, end) === m[1];
    if (cueBefore || cueAfter || alone) {
      out.push({ code: m[1], index: start });
      // claim every cue that sits before this number, so a later street number or id is not taken
      for (const c of cues) if (c.end <= start) claimed.add(c.start);
    }
  }
  return out;
}

/** Alphanumeric codes, generalised find_code(): tokens after a cue word that mix letters and digits
 *  (Greenhouse "X7kP2mQa"), or an all-caps token placed right after the cue ("code: ABCDEFGH").
 *  find_code knew the length; here 6..10 chars are taken and the consumer filters by length. Only in
 *  mails with a strong verification context, so "Use code SAVE20" in a newsletter never counts. */
export function findAlnumCodes(text) {
  if (!STRONG_CONTEXT.test(text)) return [];
  const out = [];
  for (const c of cuePositions(text)) {
    const win = text.slice(c.end, c.end + 200);
    for (const t of win.matchAll(ALNUM_RE)) {
      const tok = t[0];
      const hasD = /\d/.test(tok), hasL = /[A-Za-z]/.test(tok);
      const idx = c.end + t.index;
      if (!hasL) continue;                                       // all-digit: the numeric path owns it
      if (/^\d+(?:px|pt|em|th|st|nd|rd|am|pm|kb|mb|gb|hrs?|mins?|x\d+)$/i.test(tok)) continue;
      if (PROMO_AFTER.test(text.slice(idx + tok.length, idx + tok.length + 20))) continue;
      if (ID_TOKEN.test(tok) || NOISE_BEFORE.test(text.slice(Math.max(0, idx - 40), idx))) continue;
      const immediate = /^\s*(?:is)?\s*[:\-]?\s*$/i.test(win.slice(0, t.index));
      const mixed = hasD && hasL;
      const caps = /^[A-Z0-9]+$/.test(tok) && !ALNUM_STOP.has(tok);
      if (mixed || (caps && immediate)) { out.push({ code: tok, index: idx }); break; }
    }
  }
  return out;
}

/** All code candidates in document order, deduplicated. Gate from mail_otp.py: nothing unless
 *  VERIFY_HINT matches subject + start of the body. */
export function extractCodes({ subject = '', text = '', html = '' } = {}) {
  const hay = codeSearchText(subject, text, html);
  if (!VERIFY_HINT.test(`${subject}\n${hay.slice(0, 4000)}`)) return [];
  const all = [...findNumericCodes(hay, subject), ...findAlnumCodes(hay)].sort((a, b) => a.index - b.index);
  const seen = new Set();
  const out = [];
  for (const { code } of all) {
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= MAX_CODES) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- links
export function cleanLink(link) {
  let l = String(link).replace(/&amp;/gi, '&');
  l = decodeEntities(l);
  return l.replace(/[).,;:!\]>]+$/, '');
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/** Verification links. mail_otp.py (no link_hint): keep a link when VERIFY_HINT matches it or it is a
 *  myworkday link, after skipping unsubscribe/privacy/logo/images/mailto. Added: tracking pixels,
 *  assets, preference pages; links on a known ATS host when the subject asks for verification
 *  (SuccessFactors / iCIMS links often carry no hint word). Strong links first. */
export function extractLinks({ subject = '', text = '', html = '' } = {}) {
  const subjHint = VERIFY_HINT.test(subject || '');
  const found = [];
  const seen = new Set();
  const raw = `${text || ''}\n${html || ''}`;
  for (const m of raw.matchAll(LINK_RE)) {
    const link = cleanLink(m[0]);
    const low = link.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    if (PY_LINK_SKIP.some((k) => low.includes(k))) continue;
    if (SKIP_LINK_EXTRA.test(low)) continue;
    const host = hostOf(link);
    if (!host) continue;
    let score = 0;
    if (STRONG_LINK.test(low)) score = 3;
    else if (VERIFY_HINT.test(link)) score = 2;
    else if (low.includes('myworkday')) score = 1;
    else if (subjHint && ATS_HOST_RE.test(host)) score = 1;
    if (score) found.push({ link, score, order: found.length });
  }
  found.sort((a, b) => b.score - a.score || a.order - b.order);
  return found.slice(0, MAX_LINKS).map((f) => f.link);
}

// ------------------------------------------------------------------------------------------- is_human
const SYSTEM_LOCAL = /(?:^|[-_.+])(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|noreply|notifications?|notify|alerts?|mailer[-_.]?daemon|postmaster|bounces?|system|automated|auto|robot|bot|info|news(?:letter)?|hello|support|team|jobs?|careers?|talent|recruit(?:ing|ment|er)?s?|hr|apply|applications?|candidates?|workday|admin|accounts?|security|verify|verification|marketing|updates?|digest|service|help|mail|email|messages?|reply|confirm|onboarding|hiring|people)(?:$|[-_.+\d])/i;
export const SYSTEM_DOMAIN_RE = /(?:^|\.)(?:myworkday\.com|myworkdayjobs\.com|myworkdaysite\.com|workday\.com|greenhouse\.io|greenhouse-mail\.io|icims\.com|successfactors\.(?:com|eu)|sapsf\.(?:com|eu|cn)|oraclecloud\.com|oracle\.com|taleo\.net|lever\.co|ashbyhq\.com|smartrecruiters\.com|jobvite\.com|eightfold\.ai|phenompeople\.com|sendgrid\.net|amazonses\.com|mailgun\.org|mandrillapp\.com|mcsv\.net|sparkpostmail\.com|linkedin\.com|indeed\.com|naukri\.com|apply\.vloombox\.com)$/i;
const TEMPLATED_TEXT = /do[- ]?not reply|please do not respond|no[- ]reply|this (?:is an? |e-?mail (?:was|is|has been) )?(?:automated|automatically generated|auto-generated)|auto(?:mated|matically)?[- ]generated|automated (?:message|e-?mail|notification)|you are receiving this|you received this (?:e-?mail|message) because|unsubscribe|manage (?:your )?(?:e-?mail )?preferences|verify your|activate your (?:candidate )?account|reset your password|password reset|one[- ]time pass|verification code|security code|we (?:have )?received your application|your application (?:has been|was) (?:received|submitted)|application (?:received|submitted)/i;

export function headerMap(headers) {
  const map = {};
  for (const h of headers || []) {
    const k = String(h.key || '').toLowerCase();
    if (!(k in map)) map[k] = String(h.value || '');
  }
  return map;
}

/** Conservative: true only for a personal-looking sender address on a mail that carries none of the
 *  automated-mail signals (list/bulk/auto-submitted headers, codes, verification links, ATS template
 *  phrases). A false "true" forwards a system mail to the user; a false "false" hides a recruiter, so
 *  personal names on ATS relay domains (jane.doe@hire.lever.co) still count as human. */
export function decideIsHuman({ fromAddr = '', headers = {}, subject = '', text = '', codes = [], links = [] } = {}) {
  const addr = String(fromAddr).toLowerCase();
  const at = addr.lastIndexOf('@');
  if (at < 1) return false;
  const local = addr.slice(0, at), domain = addr.slice(at + 1);
  if (SYSTEM_LOCAL.test(local)) return false;
  if (SYSTEM_DOMAIN_RE.test(domain) && !/^[a-z]{2,}(?:[._-][a-z]{1,}){1,2}$/.test(local)) return false;
  const auto = (headers['auto-submitted'] || '').trim().toLowerCase();
  if (auto && auto !== 'no') return false;
  if (/^(?:bulk|list|junk|auto_reply)$/i.test((headers.precedence || '').trim())) return false;
  if (headers['list-unsubscribe'] || headers['list-id'] || headers['x-auto-response-suppress']) return false;
  if (headers['x-autoreply'] || headers['x-autorespond']) return false;
  if (codes.length || links.length) return false;
  if (TEMPLATED_TEXT.test(`${subject}\n${String(text).slice(0, 3000)}`)) return false;
  return true;
}

// -------------------------------------------------------------------------------------------- payload
export function rawKeyFor(date, uuid) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `mail/${y}/${m}/${d}/${uuid}.eml`;
}

export function isoSeconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const isCalendar = (a) => a && (/^(?:text|application)\/(?:calendar|ics)\b/i.test(a.mimeType || '') || /\.ics$/i.test(a.filename || ''));

/** True when the mail carries a real attachment (inline/related images such as logos do not count; nor does a
 *  calendar invite, whose details reach the API as `ics`). */
export function hasRealAttachments(list) {
  return (Array.isArray(list) ? list : []).some((a) => a && a.disposition !== 'inline' && a.related !== true && !isCalendar(a));
}

export const MAX_ICS = 32_000;

/** Text of the first calendar invite (text/calendar part or .ics attachment), capped, or null. */
export function calendarText(list) {
  const a = (Array.isArray(list) ? list : []).find(isCalendar);
  if (!a || a.content == null) return null;
  let s;
  try {
    s = typeof a.content === 'string' ? a.content : new TextDecoder('utf-8').decode(a.content instanceof ArrayBuffer ? new Uint8Array(a.content) : a.content);
  } catch {
    return null;
  }
  return /BEGIN:VEVENT/i.test(s) ? s.slice(0, MAX_ICS) : null;
}

const MEETING_LINK_RE = /https?:\/\/(?:(?:[\w-]+\.)?zoom\.us\/(?:j|my|w|s)\/|meet\.google\.com\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}|teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/|[\w-]+\.webex\.com\/(?:meet|join|[\w-]+\/j\.php)|chime\.aws\/\d|join\.skype\.com\/|(?:[\w-]+\.)?calendly\.com\/|(?:[\w-]+\.)?goodtime\.io\/)[^\s"'<>]*/gi;

/** Video-meeting and scheduling links (Zoom, Meet, Teams, Webex, Chime, Skype, Calendly, GoodTime): the verification
 *  link filter drops these, the interview extractor in the API needs them. Up to 5, in document order. */
export function extractMeetingLinks({ text = '', html = '', ics = '' } = {}) {
  const out = [];
  const seen = new Set();
  for (const m of `${text || ''}\n${html || ''}\n${ics || ''}`.matchAll(MEETING_LINK_RE)) {
    const link = cleanLink(m[0]);
    const k = link.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(link);
    if (out.length >= 5) break;
  }
  return out;
}

/** Contract body (docs/autoapply-contract.md, "Inbound mail") from a postal-mime result. */

// ------------------------------------------------------------------------------------------- authentication
export const TRUSTED_AUTHSERV = ['mx.cloudflare.net'];

/**
 * SPF / DKIM / DMARC verdicts that Cloudflare Email Routing recorded for this mail, from the TOPMOST
 * ARC-Authentication-Results / Authentication-Results header whose authserv-id is trusted (Cloudflare prepends
 * its header, so one a sender planted further down is never read first).
 * -> { spf, dkim, dmarc, dkim_domains: [...], source } or null when no trusted header exists.
 */
export function extractAuthResults(headers, { trusted = TRUSTED_AUTHSERV } = {}) {
  const ok = new Set((trusted || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean));
  for (const h of headers || []) {
    const key = String(h.key || '').toLowerCase();
    if (key !== 'arc-authentication-results' && key !== 'authentication-results') continue;
    const value = String(h.value || '').replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    const parts = value.split(';').map((x) => x.trim()).filter(Boolean);
    if (key === 'arc-authentication-results' && /^i=\d+$/i.test(parts[0] || '')) parts.shift();
    const servId = String(parts.shift() || '').split(' ')[0].toLowerCase();
    if (!ok.has(servId)) continue;
    const out = { spf: null, dkim: null, dmarc: null, dkim_domains: [], source: `${key}:${servId}` };
    for (const part of parts) {
      const m = /^(spf|dkim|dmarc)=([a-z]+)\b(.*)$/i.exec(part);
      if (!m) continue;
      const method = m[1].toLowerCase();
      const verdict = m[2].toLowerCase();
      if (method === 'dkim') {
        if (verdict === 'pass') {
          out.dkim = 'pass';
          const d = /header\.d=([^\s;]+)/i.exec(m[3]);
          if (d) out.dkim_domains.push(d[1].toLowerCase());
        } else if (!out.dkim) out.dkim = verdict;
      } else if (!out[method]) out[method] = verdict;
    }
    return out;
  }
  return null;
}

export function buildPayload(parsed, { envelopeTo = '', envelopeFrom = '', receivedAt = new Date(), rawKey = null, trustedAuthserv } = {}) {
  const p = parsed || {};
  const headers = headerMap(p.headers);
  const subject = p.subject || '';
  const html = p.html || '';
  const plain = p.text || htmlToText(html);
  const fromAddr = (p.from?.address || envelopeFrom || '').trim().toLowerCase();
  const fromName = (p.from?.name || '').trim() || null;
  const replyTo = (Array.isArray(p.replyTo) ? p.replyTo[0]?.address : p.replyTo?.address) || null;
  const codes = extractCodes({ subject, text: p.text || '', html });
  const links = extractLinks({ subject, text: p.text || '', html });
  const isHuman = decideIsHuman({ fromAddr, headers, subject, text: plain, codes, links });
  const ics = calendarText(p.attachments);
  return {
    to: String(envelopeTo || '').trim().toLowerCase(),
    from: fromAddr,
    from_name: fromName,
    subject,
    received_at: isoSeconds(receivedAt),
    codes,
    links,
    is_human: isHuman,
    has_attachments: hasRealAttachments(p.attachments),
    text_excerpt: plain.trim().slice(0, 2000),
    raw_key: rawKey,
    reply_to: replyTo ? replyTo.toLowerCase() : null,
    message_id: p.messageId || headers['message-id'] || null,
    meeting_links: extractMeetingLinks({ text: p.text || '', html, ics: ics || '' }),
    ics,
    auth: extractAuthResults(p.headers, trustedAuthserv ? { trusted: trustedAuthserv } : {}),
  };
}

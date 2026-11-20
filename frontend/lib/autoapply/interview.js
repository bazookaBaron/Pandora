/**
 * Interview details from one mail. Pure (no network, no clock: received_at anchors a missing year).
 *
 *   extractInterview({ subject, sender, from_name, text_excerpt, links, meeting_links, ics, received_at, company })
 *     -> { company, role, starts_at, ends_at, timezone, tz_assumed, time_text, duration_min, meeting_url,
 *          meeting_provider, schedule_url, location, mode, round, interview_type, source }
 *
 * Sources, best first: a calendar invite (.ics text from the Email Worker), then the mail text.
 * starts_at is an ISO UTC instant. When the mail names no time zone the time is read as India time
 * (Asia/Kolkata, most Vloombox users) and tz_assumed is true so the UI can say so.
 */
import { companyFromMail } from "./classify.js";

export const DEFAULT_TZ = "Asia/Kolkata";

// ── time zones ─────────────────────────────────────────────────────────────
// Fixed-offset abbreviations (minutes east of UTC) and the ambiguous US short names (resolved via IANA, DST aware).
const ABBR_OFFSET = {
  IST: 330, UTC: 0, GMT: 0, Z: 0, BST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180, WET: 0, WEST: 60,
  PST: -480, PDT: -420, MST: -420, MDT: -360, CST: -360, CDT: -300, EST: -300, EDT: -240, AKST: -540, AKDT: -480, HST: -600,
  SGT: 480, HKT: 480, JST: 540, KST: 540, AEST: 600, AEDT: 660, ACST: 570, AWST: 480, NZST: 720, NZDT: 780, GST: 240, PKT: 300,
  NPT: 345, BDT: 360, ICT: 420, WIB: 420, PHT: 480, MSK: 180, SAST: 120, CAT: 120, EAT: 180, WAT: 60, BRT: -180, ART: -180,
};
const ABBR_ZONE = { PT: "America/Los_Angeles", MT: "America/Denver", CT: "America/Chicago", ET: "America/New_York" };
// Windows zone names that show up in Outlook / Teams invites.
const WINDOWS_ZONE = {
  "india standard time": "Asia/Kolkata", "pacific standard time": "America/Los_Angeles", "mountain standard time": "America/Denver",
  "central standard time": "America/Chicago", "eastern standard time": "America/New_York", "gmt standard time": "Europe/London",
  "w. europe standard time": "Europe/Berlin", "central europe standard time": "Europe/Budapest", "romance standard time": "Europe/Paris",
  "singapore standard time": "Asia/Singapore", "tokyo standard time": "Asia/Tokyo", "aus eastern standard time": "Australia/Sydney",
  "arabian standard time": "Asia/Dubai", "utc": "UTC", "coordinated universal time": "UTC", "china standard time": "Asia/Shanghai",
};
const TZ_ALIASES = { "asia/calcutta": "Asia/Kolkata" };

function validZone(z) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: z }); return true; } catch { return false; }
}

/** Normalise a TZID / zone name to an IANA zone, or null. */
export function ianaZone(name) {
  if (!name) return null;
  const s = String(name).trim().replace(/^"|"$/g, "");
  const low = s.toLowerCase();
  if (WINDOWS_ZONE[low]) return WINDOWS_ZONE[low];
  if (TZ_ALIASES[low]) return TZ_ALIASES[low];
  if (/^[A-Za-z]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?$/.test(s) && validZone(s)) return s;
  // Outlook style "(UTC+05:30) Chennai, Kolkata, Mumbai, New Delhi"
  const m = /\(UTC([+-]\d{2}):?(\d{2})\)/i.exec(s);
  if (m) return `fixed:${Number(m[1]) * 60 + Math.sign(Number(m[1]) || 1) * Number(m[2])}`;
  return null;
}

/** Offset (minutes east of UTC) of an IANA zone at a UTC instant. */
function zoneOffsetAt(zone, utcMs) {
  if (zone.startsWith("fixed:")) return Number(zone.slice(6));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  return Math.round((asUtc - utcMs) / 60000);
}

/** Wall-clock time in a zone -> UTC ms. zone: IANA, 'fixed:<min>', or null (= DEFAULT_TZ). */
export function wallToUtc({ y, mo, d, h = 0, mi = 0 }, zone) {
  const z = zone || DEFAULT_TZ;
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let t = wall - zoneOffsetAt(z, wall) * 60000;
  t = wall - zoneOffsetAt(z, t) * 60000;                     // second pass settles DST edges
  return t;
}

// ── .ics ───────────────────────────────────────────────────────────────────
function unfold(ics) {
  return String(ics || "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}
const icsText = (v) => String(v || "").replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();

/** True for a real calendar date (no 31 Nov / 30 Feb, which Date.UTC would silently roll into the next month). */
export function isRealDate(y, mo, d) {
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d) || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function icsDate(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value || "").trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  const parts = { y: +y, mo: +mo, d: +d, h: h ? +h : 0, mi: mi ? +mi : 0 };
  if (!isRealDate(parts.y, parts.mo, parts.d) || parts.h > 23 || parts.mi > 59) return null;
  if (!h) return { iso: null, dateOnly: parts, zone: null };
  if (z) return { iso: new Date(Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi)).toISOString(), zone: "UTC" };
  const zone = ianaZone(params.TZID);
  return { iso: new Date(wallToUtc(parts, zone)).toISOString(), zone: zone && !zone.startsWith("fixed:") ? zone : params.TZID || null, assumed: !zone };
}

/** First VEVENT of an .ics text: { summary, description, location, url, organizer, start, end, method } or null. */
export function parseIcs(ics) {
  const text = unfold(ics);
  const ev = /BEGIN:VEVENT\n([\s\S]*?)END:VEVENT/i.exec(text);
  if (!ev) return null;
  const out = { method: (/^METHOD:(.*)$/im.exec(text) || [])[1]?.trim() || null };
  for (const line of ev[1].split("\n")) {
    const m = /^([A-Z-]+)((?:;[^:]*)?):(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toUpperCase();
    const params = Object.fromEntries(m[2].split(";").filter(Boolean).map((p) => { const i = p.indexOf("="); return [p.slice(0, i).toUpperCase(), p.slice(i + 1)]; }));
    const val = m[3];
    if (key === "DTSTART") out.start = icsDate(val, params);
    else if (key === "DTEND") out.end = icsDate(val, params);
    else if (key === "SUMMARY") out.summary = icsText(val);
    else if (key === "DESCRIPTION") out.description = icsText(val);
    else if (key === "LOCATION") out.location = icsText(val);
    else if (key === "URL") out.url = icsText(val);
    else if (key === "ORGANIZER") out.organizer = params.CN ? icsText(params.CN).replace(/^"|"$/g, "") : icsText(val).replace(/^mailto:/i, "");
    else if (key === "X-GOOGLE-CONFERENCE" || key === "X-MICROSOFT-SKYPETEAMSMEETINGURL") out.conference = icsText(val);
  }
  return out;
}

// ── meeting links ──────────────────────────────────────────────────────────
const MEETING = [
  ["zoom", /https?:\/\/(?:[\w-]+\.)?zoom\.us\/(?:j|my|w|s)\/[^\s"'<>)\]]+/i],
  ["google_meet", /https?:\/\/meet\.google\.com\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}(?:\?[^\s"'<>)\]]*)?/i],
  ["teams", /https?:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s"'<>)\]]+/i],
  ["webex", /https?:\/\/[\w-]+\.webex\.com\/(?:meet|join|[\w-]+\/j\.php)[^\s"'<>)\]]*/i],
  ["chime", /https?:\/\/chime\.aws\/\d+/i],
  ["skype", /https?:\/\/join\.skype\.com\/[^\s"'<>)\]]+/i],
  ["hirevue", /https?:\/\/[\w.-]*hirevue\.com\/[^\s"'<>)\]]+/i],
];
const SCHEDULE = /https?:\/\/(?:[\w-]+\.)?(?:calendly\.com|goodtime\.io|cal\.com|youcanbook\.me|calendar\.app\.google|outlook\.office\.com\/bookwithme|[\w.-]*ashbyhq\.com\/[^\s"'<>]*schedul|[\w.-]*greenhouse\.io\/[^\s"'<>]*(?:schedul|availability)|[\w.-]*lever\.co\/[^\s"'<>]*(?:schedul|availability)|[\w.-]*modernloop\.io|[\w.-]*prelude\.co)[^\s"'<>)\]]*/i;

const VIRTUAL_PLACE = /\b(?:microsoft teams|teams meeting|zoom|google meet|webex|skype|online|virtual|video call|phone|tbd|n\/a)\b/i;
const trimUrl = (u) => u.replace(/&amp;/g, "&").replace(/[).,;:!\]>]+$/, "");

/** First video-meeting link in the given texts: { url, provider } or null. */
export function findMeetingLink(...texts) {
  const hay = texts.flat().filter(Boolean).join("\n");
  let best = null;
  for (const [provider, re] of MEETING) {
    const m = re.exec(hay);
    if (m && (!best || m.index < best.index)) best = { url: trimUrl(m[0]), provider, index: m.index };
  }
  return best ? { url: best.url, provider: best.provider } : null;
}

export function findScheduleLink(...texts) {
  const m = SCHEDULE.exec(texts.flat().filter(Boolean).join("\n"));
  return m ? trimUrl(m[0]) : null;
}

// ── dates in text ──────────────────────────────────────────────────────────
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MON = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DAY = "(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?,?\\s+)?";
const DATE_RES = [
  // 24 November 2026 / Tue, 24th Nov, 2026 / 24 Nov
  { re: new RegExp(`\\b${DAY}(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MON},?(?:\\s+(\\d{4}))?\\b`, "gi"), map: (m) => ({ d: +m[1], mo: MONTHS[m[2].slice(0, 3).toLowerCase()], y: m[3] ? +m[3] : null }) },
  // November 24, 2026 / Tuesday, Nov 24th
  { re: new RegExp(`\\b${DAY}${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi"), map: (m) => ({ d: +m[2], mo: MONTHS[m[1].slice(0, 3).toLowerCase()], y: m[3] ? +m[3] : null }) },
  // 2026-11-24
  { re: /\b(20\d{2})-(\d{2})-(\d{2})\b/g, map: (m) => ({ y: +m[1], mo: +m[2], d: +m[3] }) },
  // 24/11/2026 (day first, as in India; 11/24/2026 is read month first because 24 cannot be a month)
  { re: /\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/g, map: (m) => (+m[2] > 12 ? { mo: +m[1], d: +m[2], y: +m[3] } : { d: +m[1], mo: +m[2], y: +m[3] }) },
];
const TIME_RE = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])|\b([01]?\d|2[0-3]):([0-5]\d)(?!\d)(?:\s*(?:hrs|hours|h)\b)?/gi;
const TZ_RE = /^\s*(?:\(\s*)?(?:(?:GMT|UTC)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?|([A-Z]{1,4})\b(?:\s*[+-]\s*\d)?|([A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)|(India|Pacific|Eastern|Central|Mountain|Singapore|Greenwich Mean|Coordinated Universal)\s+(?:Standard |Daylight )?Time)/;
const NOT_TZ = new Set(["TO", "ON", "AT", "IN", "OR", "AND", "THE", "FOR", "A", "I", "AM", "PM", "IF", "IS", "BY", "VIA", "WITH"]);

function to24(h, ampm) {
  if (!ampm) return h;
  const pm = /^p/i.test(ampm);
  if (h === 12) return pm ? 12 : 0;
  return pm ? h + 12 : h;
}

function parseTimeAt(text, idx) {
  TIME_RE.lastIndex = idx;
  const m = TIME_RE.exec(text);
  if (!m) return null;
  const ampm = m[3] || null;
  const h = ampm ? +m[1] : +m[4];
  const mi = ampm ? (m[2] ? +m[2] : 0) : +m[5];
  if (ampm && (h < 1 || h > 12)) return null;
  return { index: m.index, end: m.index + m[0].length, h: to24(h, ampm), mi, ampm, raw: m[0] };
}

function zoneFromToken(text) {
  const m = TZ_RE.exec(text);
  if (!m) return null;
  if (m[1]) {
    const off = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
    return { zone: `fixed:${off}`, label: `GMT${m[1]}${String(m[2]).padStart(2, "0")}:${m[3] || "00"}`, len: m[0].length };
  }
  if (m[4]) {
    const ab = m[4].toUpperCase();
    if (NOT_TZ.has(ab)) return null;
    if (ab in ABBR_OFFSET) return { zone: `fixed:${ABBR_OFFSET[ab]}`, label: ab, len: m[0].length };
    if (ABBR_ZONE[ab]) return { zone: ABBR_ZONE[ab], label: ab, len: m[0].length };
    return null;
  }
  if (m[5]) { const z = ianaZone(m[5]); return z ? { zone: z, label: m[5], len: m[0].length } : null; }
  if (m[6]) {
    const z = ianaZone(`${m[6]} Standard Time`) || (m[6].toLowerCase().startsWith("greenwich") ? "UTC" : null);
    return z ? { zone: z, label: m[0].trim().replace(/^\(\s*/, ""), len: m[0].length } : null;
  }
  return null;
}

function inferYear({ d, mo }, receivedAt) {
  const r = receivedAt ? new Date(receivedAt) : null;
  if (!r || Number.isNaN(r.getTime())) return null;
  const y = r.getUTCFullYear();
  // an interview date is after the mail; allow a week back for "as discussed on ..." text
  return Date.UTC(y, mo - 1, d) < r.getTime() - 7 * 86400000 ? y + 1 : y;
}

/** First date with a time in the text: { starts_at, ends_at, timezone, tz_assumed, time_text, duration_min } or null. */
export function findDateTime(text, { receivedAt = null } = {}) {
  const s = String(text || "");
  const found = [];
  for (const { re, map } of DATE_RES) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      const p = map(m);
      if (!p.mo || p.mo > 12 || p.d < 1 || p.d > 31) continue;
      found.push({ ...p, index: m.index, end: m.index + m[0].length, raw: m[0] });
    }
  }
  found.sort((a, b) => a.index - b.index);
  for (const dt of found) {
    // time after the date ("on 24 Nov at 3 PM") or just before it ("3 PM on 24 Nov")
    let t = parseTimeAt(s, dt.end);
    if (t && t.index - dt.end > 40) t = null;
    if (!t) {
      const back = Math.max(0, dt.index - 30);
      const cand = parseTimeAt(s, back);
      if (cand && cand.end <= dt.index) t = cand;
    }
    if (!t) continue;
    const y = dt.y || inferYear(dt, receivedAt);
    if (!y || !isRealDate(y, dt.mo, dt.d)) continue;
    // an end time: "3:00 PM - 4:00 PM", "15:00 to 16:00"
    let end = null;
    const rest = s.slice(t.end, t.end + 30);
    const rm = /^\s*(?:-|–|—|to|until|till)\s*/i.exec(rest);
    if (rm) {
      const e = parseTimeAt(s, t.end + rm[0].length);
      if (e && e.index === t.end + rm[0].length) end = { ...e, h: e.ampm ? e.h : (t.ampm && !e.ampm && /^p/i.test(t.ampm) && e.h < 12 ? e.h + 12 : e.h) };
    }
    const afterTime = end ? end.end : t.end;
    const zoneTok = zoneFromToken(s.slice(afterTime, afterTime + 60)) || zoneFromToken(s.slice(dt.end, dt.end + 40));
    const zone = zoneTok ? zoneTok.zone : null;
    const startMs = wallToUtc({ y, mo: dt.mo, d: dt.d, h: t.h, mi: t.mi }, zone);
    let endMs = end ? wallToUtc({ y, mo: dt.mo, d: dt.d, h: end.h, mi: end.mi }, zone) : null;
    if (endMs != null && endMs <= startMs) endMs = null;
    const lo = Math.min(dt.index, t.index);
    const hi = Math.max(dt.end, afterTime + (zoneTok ? zoneTok.len : 0));
    let timeText = s.slice(lo, hi).replace(/\s+/g, " ").trim().slice(0, 120);
    if ((timeText.match(/\(/g) || []).length > (timeText.match(/\)/g) || []).length) timeText += ")";
    return {
      starts_at: new Date(startMs).toISOString(),
      ends_at: endMs ? new Date(endMs).toISOString() : null,
      timezone: zoneTok ? zoneTok.label : null,
      tz_assumed: !zoneTok,
      time_text: timeText,
      duration_min: endMs ? Math.round((endMs - startMs) / 60000) : null,
    };
  }
  return null;
}

// ── role, round, type ──────────────────────────────────────────────────────
const cleanRole = (r) => {
  let s = String(r || "")
    .replace(/\s*[([]\s*(?:job\s*)?(?:id|req|r|jr)?[\s#:]*[A-Z]{0,4}[-_]?\d{3,}\s*[)\]]/gi, "")
    .replace(/\s*[-–|]\s*(?:job\s*)?(?:id|req(?:uisition)?)\b.*$/i, "")
    .replace(/\s+(?:at|with|@)\s+[A-Z][\w&.' -]*$/, "")
    .replace(/\s+(?:position|role|opening|opportunity)$/i, "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/[.,:;!\s]+$/, "")
    .trim();
  if (s.length < 2 || s.length > 90) return null;
  if (/^(?:interview|invitation|invite|update|your application|next steps?|call|meeting|schedule|confirmation)$/i.test(s)) return null;
  return s;
};

const ROLE_SUBJECT = [
  /\binterview\b[^:\n]*?(?:\bfor\b|[:–|-])\s*(?:the\s+)?(?:position of\s+|role of\s+)?(.+?)(?:\s+(?:role|position))?(?:\s+(?:at|with|@)\s+.+)?$/i,
  /^(.+?)\s+(?:role|position)?\s*[-–|:]\s*interview\b/i,
];
const ROLE_BODY = [
  /\bfor the (?:position|role|post) of\s+([^.,;\n]{2,80})/i,
  /\bfor the\s+([^.,;\n]{2,70}?)\s+(?:position|role|opening)\b/i,
  /\b(?:position|role|job title|job)\s*:\s*([^\n]{2,80})/i,
  /\binterview for\s+(?:the\s+)?([^.,;\n]{2,70}?)(?:\s+(?:position|role))?(?:\s+(?:at|with)\b|[.,;\n])/i,
  /\byour application for\s+(?:the\s+)?([^.,;\n]{2,70}?)(?:\s+(?:position|role))?(?:\s+(?:at|with)\b|[.,;\n])/i,
];

function dropCompany(role, company) {
  if (!role || !company) return role;
  const esc = String(company).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = role.replace(new RegExp(`\\s*(?:[-–|@,:]|\\bat\\b|\\bwith\\b)\\s*${esc}\\s*$`, "i"), "").replace(new RegExp(`^${esc}\\s*[-–|:]\\s*`, "i"), "").trim();
  return out.length >= 2 ? out : role;
}

export function findRole(subject, body, company = null) {
  for (const re of ROLE_SUBJECT) { const m = re.exec(String(subject || "")); const r = m && cleanRole(dropCompany(m[1], company)); if (r) return r; }
  for (const re of ROLE_BODY) { const m = re.exec(String(body || "")); const r = m && cleanRole(dropCompany(m[1], company)); if (r) return r; }
  return null;
}

const ORD = { first: 1, "1st": 1, one: 1, second: 2, "2nd": 2, two: 2, third: 3, "3rd": 3, three: 3, fourth: 4, "4th": 4, four: 4, fifth: 5, "5th": 5, five: 5 };
const TYPE_RES = [
  ["system_design", /\bsystem design\b/i],
  ["coding", /\b(?:coding|live coding|pair programming|dsa)\s+(?:round|interview|session)\b/i],
  ["technical", /\btechnical\s+(?:round|interview|discussion|screen)\b|\btech(?:nical)? round\b/i],
  ["hiring_manager", /\b(?:hiring manager|managerial)\s+(?:round|interview|discussion|call|chat)?\b/i],
  ["behavioral", /\b(?:behaviou?ral|culture(?:[- ]fit)?|values)\s+(?:round|interview)\b/i],
  ["hr", /\bhr\s+(?:round|interview|discussion|call)\b/i],
  ["recruiter_screen", /\b(?:recruiter|screening|phone screen|initial)\s+(?:call|screen|chat|conversation|interview)\b|\bphone screen\b/i],
  ["panel", /\bpanel\s+interview\b|\binterview loop\b|\bonsite loop\b/i],
];

export function findRound(text) {
  const s = String(text || "");
  let m = /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|final|last|next)\s+(?:round|stage)\b/i.exec(s);
  if (m) {
    const w = m[1].toLowerCase();
    return w === "final" || w === "last" ? "Final round" : w === "next" ? "Next round" : `Round ${ORD[w]}`;
  }
  m = /\b(?:round|stage)\s*(?:#\s*)?(\d|one|two|three|four|five)\b/i.exec(s);
  if (m) return `Round ${ORD[m[1].toLowerCase()] || m[1]}`;
  return null;
}

export function findInterviewType(text) {
  for (const [t, re] of TYPE_RES) if (re.test(String(text || ""))) return t;
  return null;
}

function findMode(text, meeting, location) {
  if (meeting) return "video";
  const s = String(text || "");
  if (/\b(?:on-?site|in[- ]person|at our office|office address|visit our office|venue)\b/i.test(s) || (location && !/^https?:/i.test(location) && /\d|road|street|floor|office|tower|park/i.test(location))) return "onsite";
  if (/\b(?:phone|telephonic|telephone)\s+(?:call|screen|interview|round)\b|\bwe will call you\b/i.test(s)) return "phone";
  if (/\b(?:video|virtual|online)\s+(?:call|interview|meeting)\b/i.test(s)) return "video";
  return null;
}

/**
 * @returns {object|null} null when the mail carries nothing interview-like at all.
 */
export function extractInterview(m = {}) {
  const subject = String(m.subject || "");
  const body = String(m.text_excerpt || m.text || "");
  const ics = typeof m.ics === "string" && m.ics ? parseIcs(m.ics) : null;
  const links = [...(Array.isArray(m.meeting_links) ? m.meeting_links : []), ...(Array.isArray(m.links) ? m.links : [])];
  const icsTexts = ics ? [ics.url, ics.conference, ics.location, ics.description].filter(Boolean) : [];

  const meeting = findMeetingLink(icsTexts, links, body);
  const schedule = findScheduleLink(links, body, icsTexts);
  const all = `${subject}\n${body}\n${ics ? `${ics.summary || ""}\n${ics.description || ""}` : ""}`;
  if (!ics && !meeting && !schedule && !/\binterview/i.test(all)) return null;

  const bodyNoUrls = body.replace(/https?:\/\/\S+/g, " ");
  let when = null;
  let source = "text";
  if (ics && ics.start && ics.start.iso) {
    const startMs = Date.parse(ics.start.iso);
    const endMs = ics.end && ics.end.iso ? Date.parse(ics.end.iso) : null;
    when = {
      starts_at: ics.start.iso,
      ends_at: endMs && endMs > startMs ? ics.end.iso : null,
      timezone: ics.start.zone || null,
      tz_assumed: !!ics.start.assumed,
      time_text: null,
      duration_min: endMs && endMs > startMs ? Math.round((endMs - startMs) / 60000) : null,
    };
    source = "ics";
  } else {
    when = findDateTime(`${subject}\n${body}`, { receivedAt: m.received_at });
  }
  if (!when) {
    const dm = /\b(\d{2,3})\s*(?:-|\s)?\s*(?:minutes?|mins?)\b|\b(an?|one|1(?:\.5)?|two|2)\s*(?:-|\s)?\s*hours?\b/i.exec(bodyNoUrls);
    when = { starts_at: null, ends_at: null, timezone: null, tz_assumed: false, time_text: null, duration_min: dm ? (dm[1] ? +dm[1] : /1\.5/.test(dm[2]) ? 90 : /two|2/i.test(dm[2]) ? 120 : 60) : null };
  } else if (when.duration_min == null) {
    const dm = /\b(\d{2,3})\s*(?:-|\s)?\s*(?:minutes?|mins?)\b/i.exec(bodyNoUrls);
    if (dm) when.duration_min = +dm[1];
  }

  const location = ics && ics.location && !/^https?:/i.test(ics.location) && !findMeetingLink(ics.location) && !VIRTUAL_PLACE.test(ics.location) ? ics.location.slice(0, 300) : null;
  const company = m.company || companyFromMail({ sender: m.sender, from_name: m.from_name, subject }) || null;
  return {
    company,
    role: findRole(ics && ics.summary && /interview/i.test(ics.summary) ? ics.summary : subject, body, company) || findRole(subject, body, company),
    starts_at: when.starts_at,
    ends_at: when.ends_at,
    timezone: when.timezone,
    tz_assumed: when.starts_at ? when.tz_assumed : false,
    time_text: when.time_text,
    duration_min: when.duration_min,
    meeting_url: meeting ? meeting.url : null,
    meeting_provider: meeting ? meeting.provider : null,
    schedule_url: schedule,
    location,
    mode: findMode(all, meeting, location),
    round: findRound(all),
    interview_type: findInterviewType(all),
    source,
  };
}

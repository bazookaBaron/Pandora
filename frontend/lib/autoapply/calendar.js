/**
 * Calendar helpers for an aa_interviews row. Pure, no I/O; shared by the API tests and the browser
 * (pages/autoapply/InterviewCard.jsx).
 *
 *   interviewWindow(iv)      -> { start: Date, end: Date } | null   (end: ends_at, else start + duration_min, else 60 min)
 *   googleCalendarUrl(iv)    -> 'https://calendar.google.com/calendar/render?action=TEMPLATE&...' | null
 *   buildIcs(iv, { now })    -> RFC 5545 VCALENDAR text (CRLF, folded at 75 octets) | null
 */

const MIN_MS = 60 * 1000;
const MAX_DURATION_MIN = 12 * 60;

function validDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function interviewWindow(iv) {
  const start = validDate(iv && iv.starts_at);
  if (!start) return null;
  let end = validDate(iv.ends_at);
  if (!end || end <= start) {
    const dur = Number(iv.duration_min);
    const min = Number.isFinite(dur) && dur > 0 ? Math.min(dur, MAX_DURATION_MIN) : 60;
    end = new Date(start.getTime() + min * MIN_MS);
  }
  return { start, end };
}

/** 20261124T050000Z */
export const icsStamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

const safeUrl = (u) => {
  try {
    const x = new URL(String(u));
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : null;
  } catch {
    return null;
  }
};

export function interviewTitle(iv) {
  const who = iv.company ? String(iv.company).trim() : "";
  const parts = ["Interview", who && `with ${who}`, iv.role && `· ${String(iv.role).trim()}`].filter(Boolean);
  return parts.join(" ").slice(0, 200);
}

function interviewDetails(iv) {
  const lines = [];
  if (iv.round) lines.push(String(iv.round));
  const join = safeUrl(iv.meeting_url);
  if (join) lines.push(`Join: ${join}`);
  const sched = safeUrl(iv.schedule_url);
  if (sched && !join) lines.push(`Scheduling link: ${sched}`);
  if (iv.time_text) lines.push(`As written in the mail: ${String(iv.time_text).slice(0, 200)}`);
  if (iv.tz_assumed) lines.push("The mail did not name a time zone; read as India time. Check the mail.");
  lines.push("Added from Vloombox AutoApply");
  return lines.join("\n");
}

const where = (iv) => String(iv.location || safeUrl(iv.meeting_url) || "").slice(0, 500);

export function googleCalendarUrl(iv) {
  const w = interviewWindow(iv);
  if (!w) return null;
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: interviewTitle(iv),
    dates: `${icsStamp(w.start)}/${icsStamp(w.end)}`,
    details: interviewDetails(iv),
  });
  const loc = where(iv);
  if (loc) p.set("location", loc);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma, newline. */
export const icsEscape = (s) =>
  String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");

const utf8Len = (s) => new TextEncoder().encode(s).length;

/** Fold a content line at 75 octets (continuation lines start with one space), never splitting a character. */
export function foldLine(line) {
  if (utf8Len(line) <= 75) return line;
  const out = [];
  let cur = "";
  let limit = 75;
  for (const ch of line) {
    if (utf8Len(cur + ch) > limit) {
      out.push(cur);
      cur = "";
      limit = 74; // the leading space counts
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out.join("\r\n ");
}

export function buildIcs(iv, { now = new Date() } = {}) {
  const w = interviewWindow(iv);
  if (!w) return null;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Vloombox//AutoApply//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:aa-iv-${String(iv.id ?? iv.mail_event_id ?? icsStamp(w.start)).replace(/[^A-Za-z0-9-]/g, "")}@vloombox.in`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART:${icsStamp(w.start)}`,
    `DTEND:${icsStamp(w.end)}`,
    `SUMMARY:${icsEscape(interviewTitle(iv))}`,
    `DESCRIPTION:${icsEscape(interviewDetails(iv))}`,
  ];
  const loc = where(iv);
  if (loc) lines.push(`LOCATION:${icsEscape(loc)}`);
  const join = safeUrl(iv.meeting_url);
  if (join) lines.push(`URL:${join}`);
  lines.push(
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Interview in 1 hour",
    "TRIGGER:-PT1H",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  );
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

export function icsFileName(iv) {
  const slug = String(iv.company || "interview").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "interview";
  return `interview-${slug}.ics`;
}

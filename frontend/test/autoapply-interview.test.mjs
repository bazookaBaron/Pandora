/**
 * AutoApply mail: rejection category, kinds, company guess, interview extraction (.ics + text), alerts for
 * rejections, backfill. Pure / in-memory. Run: npm run test:autoapply
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyMail, companyFromMail, isRejection } from "../lib/autoapply/classify.js";
import { extractInterview, findDateTime, parseIcs, findMeetingLink, findRole, findRound, findInterviewType, wallToUtc } from "../lib/autoapply/interview.js";
import { backfillMail, sendDailyAlerts, describeAlert } from "../lib/autoapply/mailJobs.js";
import { createFakeDb } from "./fixtures/fakeSupabase.mjs";

const cls = (subject, text_excerpt = "", extra = {}) => classifyMail({ subject, text_excerpt, ...extra });
const cat = (...a) => cls(...a).category;
const kind = (...a) => cls(...a).kind;

// ── rejections ─────────────────────────────────────────────────────────────
const REJECTIONS = [
  ["Your application to Acme", "Dear Priya,\nThank you for applying to the Backend Engineer role at Acme. Unfortunately, we have decided to move forward with other candidates whose experience more closely matches our needs.\nWe wish you the best."],
  ["Update on your application", "After careful consideration, we will not be moving forward with your application at this time."],
  ["Globex - Software Engineer", "Thank you for your interest. We have decided to pursue other candidates for this position."],
  ["Regarding your application", "We regret to inform you that you have not been selected for the next stage."],
  ["Data Analyst (R-12345)", "Thank you for applying. The position has been filled. We will keep your resume on file."],
  ["Your candidacy", "We will not be proceeding with your application for the Product Manager role."],
  ["Thank you for interviewing with Initech", "Thank you for taking the time to interview with us. Unfortunately, we have decided not to proceed further with your candidacy."],
  ["Application status", "Unfortunately your application was unsuccessful on this occasion."],
  ["Hooli careers", "Unfortunately, we are unable to offer you a position at this time. We encourage you to apply for other roles."],
];

test("classifier: clear rejections are 'rejected' and expire after 30 days", () => {
  for (const [s, t] of REJECTIONS) {
    const r = cls(s, t);
    assert.equal(r.category, "rejected", s);
    assert.equal(r.kind, "rejection", s);
    assert.equal(r.retention_days, 30, s);
  }
  // a person writing a rejection is still a rejection
  assert.equal(cat("Re: your application", "Hi Priya, I'm sorry to say we will not be moving forward with your application.", { is_human: true }), "rejected");
});

test("classifier: a rejection that also invites / offers / assesses is kept (important)", () => {
  assert.equal(cat("Interview invitation", "Unfortunately the slot on Monday is not available. Please share your availability for the interview."), "important");
  assert.equal(cat("Next round", "Unfortunately the hiring manager is out, but we would like to invite you to an interview next week."), "important");
  assert.equal(cat("Your offer letter", "We regret to inform you of a delay; your offer letter is attached."), "important");
  assert.equal(cat("Assessment", "Unfortunately the earlier test link failed. Please complete the online assessment by Friday."), "important");
  assert.equal(cat("Interview", "We have decided to move forward with other candidates for the Manager role, but would like to schedule a call for the Engineer role.", {}), "important");
  // an "unfortunately" with no application context is not a rejection
  assert.equal(isRejection("Unfortunately your verification link has expired. Here is a new one."), false);
  assert.equal(cat("Verify your email", "Unfortunately your link has expired. Your verification code is 123456", { codes: ["123456"] }), "code");
  // a calendar invite is never a rejection
  assert.equal(cat("Updated invitation", "Unfortunately we have to reschedule", { ics: "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20261124T050000Z\nEND:VEVENT\nEND:VCALENDAR" }), "important");
});

test("classifier: kinds inside important", () => {
  assert.equal(kind("Interview invitation - Backend Engineer"), "interview");
  assert.equal(kind("Next steps", "Join us on https://meet.google.com/abc-defg-hij at 3 PM"), "interview");
  assert.equal(kind("Complete your HackerRank test"), "assessment");
  assert.equal(kind("Online assessment before your interview", "Please finish it before the interview"), "assessment");
  assert.equal(kind("Your offer letter from Acme"), "offer");
  assert.equal(kind("Congratulations!", "We are pleased to offer you the role of SDE 2."), "offer");
  assert.equal(kind("Hello", "Hi, quick question about your profile", { is_human: true }), "recruiter");
  assert.equal(kind("Thanks for applying", "We received your application"), null);
  assert.equal(cls("Interview", "", { meeting_links: ["https://zoom.us/j/123"] }).category, "important");
});

// ── company ────────────────────────────────────────────────────────────────
test("companyFromMail: display name, then subject, then domain", () => {
  assert.equal(companyFromMail({ sender: "no-reply@myworkday.com", from_name: "Acme Careers" }), "Acme");
  assert.equal(companyFromMail({ sender: "talent@globex.com", from_name: "Globex Talent Acquisition Team" }), "Globex");
  assert.equal(companyFromMail({ sender: "x@hire.lever.co", from_name: "Jane at Figma" }), "Figma");
  assert.equal(companyFromMail({ sender: "noreply@greenhouse.io", from_name: "Greenhouse", subject: "Thank you for applying to Stripe" }), "Stripe");
  assert.equal(companyFromMail({ sender: "jane.doe@initech.com", from_name: "Jane Doe" }), "Initech", "a person's name falls back to the domain");
  assert.equal(companyFromMail({ sender: "no-reply@myworkday.com" }), null);
  assert.equal(companyFromMail({ sender: "careers@mail.tcs.com" }), "Tcs");
});

// ── dates ──────────────────────────────────────────────────────────────────
const RECV = "2026-11-20T06:00:00Z";

test("findDateTime: formats, time zones, ranges, missing year", () => {
  const f = (t) => findDateTime(t, { receivedAt: RECV });
  let r = f("Your interview is scheduled for Tuesday, November 24, 2026 at 10:30 AM IST.");
  assert.equal(r.starts_at, "2026-11-24T05:00:00.000Z");
  assert.equal(r.timezone, "IST");
  assert.equal(r.tz_assumed, false);

  r = f("Date: 24 Nov 2026\nTime: 3:00 PM - 4:00 PM (GMT+05:30) India Standard Time");
  assert.equal(r.starts_at, "2026-11-24T09:30:00.000Z");
  assert.equal(r.ends_at, "2026-11-24T10:30:00.000Z");
  assert.equal(r.duration_min, 60);
  assert.equal(r.timezone, "GMT+05:30");

  r = f("We'd like to meet on Nov 25 at 9am PT.");                       // no year: from received_at; PT = PST in Nov
  assert.equal(r.starts_at, "2026-11-25T17:00:00.000Z");
  r = f("Slot: 2026-11-26 14:00 UTC");
  assert.equal(r.starts_at, "2026-11-26T14:00:00.000Z");
  r = f("The call is at 11:00 on 27/11/2026.");                          // no zone: India time, flagged
  assert.equal(r.starts_at, "2026-11-27T05:30:00.000Z");
  assert.equal(r.tz_assumed, true);
  assert.equal(r.timezone, null);
  r = f("Thursday, December 3rd at 4 PM EST");
  assert.equal(r.starts_at, "2026-12-03T21:00:00.000Z");
  r = f("Interview on 5 January at 10:00 AM CET");                        // January after a November mail: next year
  assert.equal(r.starts_at, "2027-01-05T09:00:00.000Z");
  r = f("Wed, 10 June 2026 2 PM EDT");
  assert.equal(r.starts_at, "2026-06-10T18:00:00.000Z");
  assert.equal(f("Thanks for your time. Regards, the team. 2026 Acme Inc."), null);
  assert.equal(f("We will get back to you within 5 days."), null);
});

test("wallToUtc: IANA zones handle DST", () => {
  assert.equal(new Date(wallToUtc({ y: 2026, mo: 7, d: 1, h: 9, mi: 0 }, "America/New_York")).toISOString(), "2026-07-01T13:00:00.000Z");
  assert.equal(new Date(wallToUtc({ y: 2026, mo: 12, d: 1, h: 9, mi: 0 }, "America/New_York")).toISOString(), "2026-12-01T14:00:00.000Z");
  assert.equal(new Date(wallToUtc({ y: 2026, mo: 12, d: 1, h: 9, mi: 0 }, null)).toISOString(), "2026-12-01T03:30:00.000Z");
});

// ── .ics ───────────────────────────────────────────────────────────────────
const TEAMS_ICS = [
  "BEGIN:VCALENDAR",
  "METHOD:REQUEST",
  "PRODID:Microsoft Exchange Server 2010",
  "BEGIN:VTIMEZONE",
  "TZID:India Standard Time",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  'ORGANIZER;CN="Jane Recruiter":mailto:jane@acme.com',
  "DTSTART;TZID=India Standard Time:20261124T103000",
  "DTEND;TZID=India Standard Time:20261124T113000",
  "SUMMARY;LANGUAGE=en-US:Interview: Senior Frontend Engineer - Acme",
  "LOCATION;LANGUAGE=en-US:Microsoft Teams Meeting",
  String.raw`DESCRIPTION;LANGUAGE=en-US:Hi Priya\, this is your Round 2 technical interv`,
  String.raw` iew.\n\nJoin on your computer: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%7d`,
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const GOOGLE_ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "DTSTART:20261201T083000Z",
  "DTEND:20261201T091500Z",
  "SUMMARY:Globex <> Priya: Hiring manager interview",
  "LOCATION:",
  "X-GOOGLE-CONFERENCE:https://meet.google.com/xyz-abcd-efg",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\n");

test("parseIcs: folded lines, TZID (Windows names), UTC, escapes", () => {
  const ev = parseIcs(TEAMS_ICS);
  assert.equal(ev.method, "REQUEST");
  assert.equal(ev.start.iso, "2026-11-24T05:00:00.000Z");
  assert.equal(ev.start.zone, "Asia/Kolkata");
  assert.equal(ev.end.iso, "2026-11-24T06:00:00.000Z");
  assert.equal(ev.organizer, "Jane Recruiter");
  assert.match(ev.description, /^Hi Priya, this is your Round 2 technical interview\.\n\nJoin/);
  const g = parseIcs(GOOGLE_ICS);
  assert.equal(g.start.iso, "2026-12-01T08:30:00.000Z");
  assert.equal(g.conference, "https://meet.google.com/xyz-abcd-efg");
  assert.equal(parseIcs("not a calendar"), null);
});

test("findMeetingLink / role / round / type", () => {
  assert.deepEqual(findMeetingLink("Join https://us02web.zoom.us/j/8312345678?pwd=AbC. Thanks"), { url: "https://us02web.zoom.us/j/8312345678?pwd=AbC", provider: "zoom" });
  assert.equal(findMeetingLink("https://meet.google.com/abc-defg-hij").provider, "google_meet");
  assert.equal(findMeetingLink("https://acme.webex.com/meet/jane").provider, "webex");
  assert.equal(findMeetingLink("no link here https://acme.com/careers"), null);
  assert.equal(findRole("Interview Invitation - Software Engineer II at Globex", ""), "Software Engineer II");
  assert.equal(findRole("Next steps", "We'd like to invite you to interview for the Data Analyst position at Acme."), "Data Analyst");
  assert.equal(findRole("Update", "Position: Backend Engineer (R-0012345)\nLocation: Bengaluru"), "Backend Engineer");
  assert.equal(findRole("Interview: Senior Frontend Engineer - Acme", "", "Acme"), "Senior Frontend Engineer");
  assert.equal(findRound("This is the final round"), "Final round");
  assert.equal(findRound("second round of interviews"), "Round 2");
  assert.equal(findRound("Round 3: system design"), "Round 3");
  assert.equal(findInterviewType("a 45 minute system design interview"), "system_design");
  assert.equal(findInterviewType("HR round with our people team"), "hr");
  assert.equal(findInterviewType("a short phone screen"), "recruiter_screen");
});

// ── extractInterview over realistic mails ──────────────────────────────────
test("extractInterview: Outlook / Teams invite with .ics", () => {
  const x = extractInterview({ subject: "Invitation: Interview with Acme", sender: "jane@acme.com", from_name: "Jane Recruiter", text_excerpt: "Please see the calendar invite.", ics: TEAMS_ICS, received_at: RECV });
  assert.equal(x.source, "ics");
  assert.equal(x.company, "Acme");
  assert.equal(x.role, "Senior Frontend Engineer");
  assert.equal(x.starts_at, "2026-11-24T05:00:00.000Z");
  assert.equal(x.duration_min, 60);
  assert.equal(x.timezone, "Asia/Kolkata");
  assert.equal(x.meeting_provider, "teams");
  assert.match(x.meeting_url, /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//);
  assert.equal(x.mode, "video");
  assert.equal(x.round, "Round 2");
  assert.equal(x.interview_type, "technical");
  assert.equal(x.location, null, "'Microsoft Teams Meeting' is not a place");
});

test("extractInterview: Google Calendar invite", () => {
  const x = extractInterview({ subject: "Invitation: Globex <> Priya", sender: "calendar-notification@google.com", from_name: "Sam (Globex)", text_excerpt: "Sam has invited you.", ics: GOOGLE_ICS, received_at: RECV });
  assert.equal(x.starts_at, "2026-12-01T08:30:00.000Z");
  assert.equal(x.duration_min, 45);
  assert.equal(x.meeting_url, "https://meet.google.com/xyz-abcd-efg");
  assert.equal(x.interview_type, "hiring_manager");
});

test("extractInterview: Greenhouse text mail with Google Meet", () => {
  const x = extractInterview({
    subject: "Interview Invitation - Software Engineer II at Globex",
    sender: "no-reply@greenhouse.io",
    from_name: "Globex Recruiting",
    text_excerpt: "Hi Priya,\nWe'd like to invite you to a technical round (Round 2) for the Software Engineer II position.\nWhen: Wednesday, 25 November 2026, 2:00 PM - 2:45 PM IST\nGoogle Meet: https://meet.google.com/abc-defg-hij\nBest,\nGlobex Talent",
    received_at: RECV,
  });
  assert.deepEqual(
    { company: x.company, role: x.role, starts_at: x.starts_at, ends_at: x.ends_at, timezone: x.timezone, duration_min: x.duration_min, meeting_provider: x.meeting_provider, round: x.round, interview_type: x.interview_type, mode: x.mode, source: x.source },
    { company: "Globex", role: "Software Engineer II", starts_at: "2026-11-25T08:30:00.000Z", ends_at: "2026-11-25T09:15:00.000Z", timezone: "IST", duration_min: 45, meeting_provider: "google_meet", round: "Round 2", interview_type: "technical", mode: "video", source: "text" },
  );
});

test("extractInterview: Zoom link from the worker's meeting_links, US time zone", () => {
  const x = extractInterview({
    subject: "Your interview with Initech is confirmed",
    sender: "scheduling@goodtime.io",
    from_name: "Initech Recruiting",
    text_excerpt: "Your Hiring Manager interview for the Product Designer role is confirmed for Thursday, December 3 at 9:00 AM PST (60 minutes).",
    meeting_links: ["https://initech.zoom.us/j/99887766554?pwd=xyz"],
    received_at: RECV,
  });
  assert.equal(x.company, "Initech");
  assert.equal(x.role, "Product Designer");
  assert.equal(x.starts_at, "2026-12-03T17:00:00.000Z");
  assert.equal(x.duration_min, 60);
  assert.equal(x.meeting_provider, "zoom");
  assert.equal(x.interview_type, "hiring_manager");
});

test("extractInterview: schedule-your-interview mail (no time yet), onsite, phone", () => {
  const s = extractInterview({ subject: "Schedule your interview with Hooli", sender: "no-reply@hooli.com", text_excerpt: "Please pick a slot for your first round interview: https://calendly.com/hooli-recruiting/30min", received_at: RECV });
  assert.equal(s.starts_at, null);
  assert.equal(s.schedule_url, "https://calendly.com/hooli-recruiting/30min");
  assert.equal(s.round, "Round 1");
  assert.equal(s.duration_min, null);

  const o = extractInterview({ subject: "Onsite interview - Bengaluru", sender: "hr@acme.in", from_name: "Acme HR", text_excerpt: "Your in-person interview is on 28 Nov 2026 at 11:00 AM IST at our office, 5th Floor, Prestige Tower, MG Road.", received_at: RECV });
  assert.equal(o.mode, "onsite");
  assert.equal(o.starts_at, "2026-11-28T05:30:00.000Z");

  const p = extractInterview({ subject: "Telephonic interview", sender: "hr@tcs.com", text_excerpt: "We will call you for a telephonic interview on 30/11/2026 at 4 PM.", received_at: RECV });
  assert.equal(p.mode, "phone");
  assert.equal(p.tz_assumed, true);
  assert.equal(p.starts_at, "2026-11-30T10:30:00.000Z");

  assert.equal(extractInterview({ subject: "Weekly newsletter", text_excerpt: "Top jobs this week" }), null);
});

// ── alerts include rejections; received never alerts ──────────────────────
test("daily alerts: rejections are included, receipts are not", async () => {
  const now = new Date("2026-11-20T13:30:00Z");
  const iso = (ms) => new Date(now.getTime() + ms).toISOString();
  const db = createFakeDb({ aa_profiles: [{ user_id: "u-1", contact_email: "one@example.com", apply_alias: "one.aaaa" }] });
  const mailDb = createFakeDb({
    aa_mail_events: [
      { id: 1, user_id: "u-1", alias: "one.aaaa", sender: "no-reply@acme.com", subject: "Update", category: "rejected", kind: "rejection", company: "Acme", received_at: iso(-60000), expires_at: iso(86400000) },
      { id: 2, user_id: "u-1", alias: "one.aaaa", sender: "no-reply@acme.com", subject: "Thanks for applying", category: "received", received_at: iso(-60000), expires_at: iso(86400000) },
    ],
  });
  const sent = [];
  const stats = await sendDailyAlerts({ db, mailDb, resend: { async sendEmail(m) { sent.push(m); return { id: "x" }; } }, now });
  assert.equal(stats.sent, 1);
  assert.match(sent[0].text, /1 application update from Acme/);
  assert.ok(mailDb.rows("aa_mail_events").find((r) => r.id === 1).alerted_at);
  assert.equal(mailDb.rows("aa_mail_events").find((r) => r.id === 2).alerted_at ?? null, null);
  assert.equal(describeAlert([{ kind: "interview", company: "Globex", sender: "x@y.com" }, { kind: "interview", sender: "a@b.com" }]).example, "2 interviews from Globex");
});

// ── backfill ───────────────────────────────────────────────────────────────
test("backfillMail: re-classifies, fixes expiry, extracts interviews once", async () => {
  const base = { user_id: "u-1", alias: "one.aaaa", codes: [], links: [], is_human: false, received_at: "2026-11-01T00:00:00.000Z" };
  const mailDb = createFakeDb({
    aa_mail_events: [
      { ...base, id: 1, sender: "no-reply@acme.com", subject: "Your OTP", codes: ["123456"], text_excerpt: "Your one-time code: 123456", category: "code", expires_at: "2026-11-02T00:00:00.000Z" },
      { ...base, id: 2, sender: "no-reply@acme.com", subject: "Thank you for applying", text_excerpt: "Unfortunately, we have decided to move forward with other candidates.", category: "received", expires_at: "2026-11-15T00:00:00.000Z" },
      { ...base, id: 3, sender: "jane@globex.com", subject: "Interview for Data Analyst", text_excerpt: "Join on 24 Nov 2026 at 3 PM IST: https://meet.google.com/abc-defg-hij", category: "important", expires_at: "2027-04-30T00:00:00.000Z" },
      { ...base, id: 4, sender: "news@x.com", subject: "Newsletter", text_excerpt: "hi", category: "other", expires_at: "2027-04-30T00:00:00.000Z" },
      { ...base, id: 5, sender: "no-reply@acme.com", subject: "Application received", text_excerpt: "We have received your application.", category: "received", expires_at: "2026-11-15T00:00:00.000Z" },
    ],
  });
  const s = await backfillMail({ mailDb, batchSize: 2 });
  assert.equal(s.scanned, 5);
  assert.equal(s.interviews, 1);
  const by = (id) => mailDb.rows("aa_mail_events").find((r) => r.id === id);
  assert.equal(by(1).expires_at, "2026-11-08T00:00:00.000Z", "codes expire 7 days after receipt");
  assert.equal(by(2).category, "rejected");
  assert.equal(by(2).expires_at, "2026-12-01T00:00:00.000Z", "30 days after receipt");
  assert.equal(by(3).expires_at, null);
  assert.equal(by(3).kind, "interview");
  assert.equal(by(3).company, "Globex");
  assert.equal(by(4).expires_at, null);
  assert.equal(by(5).expires_at, "2026-12-01T00:00:00.000Z");
  const iv = mailDb.rows("aa_interviews");
  assert.equal(iv.length, 1);
  assert.equal(iv[0].mail_event_id, 3);
  assert.equal(iv[0].starts_at, "2026-11-24T09:30:00.000Z");
  const again = await backfillMail({ mailDb });
  assert.equal(again.updated, 0);
  assert.equal(again.interviews, 0);
  assert.equal(mailDb.rows("aa_interviews").length, 1);
});

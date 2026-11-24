/**
 * AutoApply product features: readiness score, proof of application, not-charged counts, interview reminders +
 * calendar, must-apply companies, reply-rate stats, admin health, mail dedupe. Pure functions plus the real router
 * on a throwaway Express app with the in-memory Supabase fake. Nothing leaves the process.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";

import { createAutoApplyRouter, createInboundHandler, runInterviewReminders } from "../routes/autoapply.js";
import { profileReadiness, profileReady, fixLinkFor } from "../lib/autoapply/profileGate.js";
import { googleCalendarUrl, buildIcs, foldLine, icsEscape, interviewWindow, icsFileName } from "../lib/autoapply/calendar.js";
import { reminderDue, reminderPayload, sendInterviewReminders } from "../lib/autoapply/reminders.js";
import { normMustCompanies, companyKey, sameCompany } from "../lib/autoapply/companies.js";
import { chargeSummary, matchConfirmationMails, roleFamily, replyStats } from "../lib/autoapply/insights.js";
import { healthView, healthSummary, isAdminUser } from "../lib/autoapply/health.js";
import { mailDedupeKey, signInbound, storeInbound } from "../lib/autoapply/inbound.js";
import { createFakeDb } from "./fixtures/fakeSupabase.mjs";

const H = 3600 * 1000;
const U1 = "bbbbbbbb-0000-4000-8000-000000000001";
const U2 = "bbbbbbbb-0000-4000-8000-000000000002";

// ── readiness ───────────────────────────────────────────────────────────────
test("profileReadiness: % ready, exact missing items with fix links, same gate as profileReady", () => {
  const empty = profileReadiness(null, {});
  assert.equal(empty.ok, false);
  assert.equal(empty.pct < 20, true);
  assert.deepEqual(empty.missing.map((m) => m.key), profileReady(null, {}).missing);
  const resume = empty.missing.find((m) => m.key === "resume");
  assert.equal(resume.label, "Upload your resume");
  assert.equal(resume.fix, "/autoapply/setup?step=resume");
  assert.equal(fixLinkFor("onboarding"), "/autoapply/setup?step=consent");
  assert.equal(fixLinkFor("fields.phone"), "/autoapply/setup?step=answers&field=fields.phone");

  const full = {
    onboarding_done: true,
    consent_at: "2026-11-01T00:00:00Z",
    resume_path: "u/resume.pdf",
    apply_alias: "a.b",
    profile: { name: "Priya Sharma", phone: "+91 98765 43210", city: "Bengaluru", experience: [{ company: "Acme", title: "SDE", current: true }], education: [{ school: "IIT" }] },
  };
  const answers = { "facts.total_experience_years": "4", "facts.notice_period_days": "30", "facts.currently_employed": "yes" };
  const r = profileReadiness(full, answers);
  assert.equal(profileReady(full, answers).ok, true);
  assert.deepEqual([r.ok, r.pct, r.done, r.missing.length], [true, 100, r.total, 0]);
  const two = profileReadiness(full, { "facts.total_experience_years": "4" });
  assert.deepEqual(two.missing.map((m) => m.key), ["facts.notice_period_days", "facts.currently_employed"]);
  assert.equal(two.pct, Math.floor(((two.total - 2) / two.total) * 100));
  // onboarding without the consent recorded is not done
  const noConsent = profileReadiness({ ...full, consent_at: null }, answers);
  assert.equal(noConsent.ok, false);
  assert.ok(noConsent.missing.some((m) => m.key === "onboarding"));
  const partial = profileReadiness({ ...full, resume_path: null }, answers);
  assert.equal(partial.ok, false);
  assert.ok(partial.pct > empty.pct && partial.pct < 100, `pct ${partial.pct}`);
  assert.ok(partial.missing.some((m) => m.key === "resume"));
  assert.equal(partial.done + partial.missing.length <= partial.total, true);
});

// ── calendar ────────────────────────────────────────────────────────────────
const IV = {
  id: 42, mail_event_id: 7, company: "Acme, Inc.", role: "Backend Engineer", round: "Round 2",
  starts_at: "2026-11-24T05:00:00.000Z", duration_min: 45, meeting_url: "https://meet.google.com/abc-defg-hij", meeting_provider: "google_meet",
  location: null, time_text: "Tue 24 Nov, 10:30 AM IST", tz_assumed: false,
};

test("calendar: Google Calendar template link and .ics", () => {
  const w = interviewWindow(IV);
  assert.equal(w.end.toISOString(), "2026-11-24T05:45:00.000Z");
  assert.equal(interviewWindow({ starts_at: IV.starts_at }).end.toISOString(), "2026-11-24T06:00:00.000Z", "60 min default");
  assert.equal(interviewWindow({ starts_at: null }), null);
  assert.equal(googleCalendarUrl({ starts_at: null }), null);

  const url = new URL(googleCalendarUrl(IV));
  assert.equal(url.origin + url.pathname, "https://calendar.google.com/calendar/render");
  assert.equal(url.searchParams.get("action"), "TEMPLATE");
  assert.equal(url.searchParams.get("dates"), "20261124T050000Z/20261124T054500Z");
  assert.equal(url.searchParams.get("text"), "Interview with Acme, Inc. · Backend Engineer");
  assert.match(url.searchParams.get("details"), /Join: https:\/\/meet\.google\.com\/abc-defg-hij/);
  assert.equal(url.searchParams.get("location"), "https://meet.google.com/abc-defg-hij");

  const ics = buildIcs(IV, { now: new Date("2026-11-21T00:00:00Z") });
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.match(ics, /\r\nDTSTART:20261124T050000Z\r\n/);
  assert.match(ics, /\r\nDTEND:20261124T054500Z\r\n/);
  assert.match(ics, /\r\nUID:aa-iv-42@vloombox\.in\r\n/);
  assert.match(ics, /\r\nSUMMARY:Interview with Acme\\, Inc\. · Backend Engineer\r\n/);
  assert.match(ics, /TRIGGER:-PT1H/);
  for (const line of ics.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, `line too long: ${line}`);
  assert.equal(buildIcs({ starts_at: "nope" }), null);
  assert.equal(icsFileName(IV), "interview-acme-inc.ics");
});

test("calendar: escaping and folding", () => {
  assert.equal(icsEscape("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne");
  const long = "DESCRIPTION:" + "é".repeat(80);
  const folded = foldLine(long);
  for (const l of folded.split("\r\n")) assert.ok(new TextEncoder().encode(l).length <= 75);
  assert.equal(folded.split("\r\n").map((l, i) => (i ? l.slice(1) : l)).join(""), long);
  assert.equal(foldLine("SHORT:x"), "SHORT:x");
});

// ── reminders ───────────────────────────────────────────────────────────────
test("reminderDue: 24 h slot, 1 h slot, missed slot, past", () => {
  const now = new Date("2026-11-21T10:00:00Z");
  const at = (ms) => new Date(now.getTime() + ms).toISOString();
  assert.equal(reminderDue({ starts_at: at(30 * H) }, now), null, "too early");
  assert.equal(reminderDue({ starts_at: at(23 * H) }, now), "24h");
  assert.equal(reminderDue({ starts_at: at(23 * H), reminder_24h_at: now.toISOString() }, now), null);
  assert.equal(reminderDue({ starts_at: at(50 * 60 * 1000) }, now), "1h", "missed 24 h slot -> only the 1 h one");
  assert.equal(reminderDue({ starts_at: at(50 * 60 * 1000), reminder_1h_at: now.toISOString() }, now), null);
  assert.equal(reminderDue({ starts_at: at(-60 * 1000) }, now), null, "started");
  assert.equal(reminderDue({ starts_at: null }, now), null);
  const p = reminderPayload({ ...IV, starts_at: "2026-11-24T05:00:00Z" }, "1h");
  assert.equal(p.title, "Interview in 1 hour · Acme, Inc.");
  assert.match(p.body, /10:30.*IST\. Join on Google Meet\./i);
  assert.equal(p.tag, "aa-iv-42-1h");
  assert.equal(p.url, "/autoapply/interviews");
  assert.equal(reminderPayload(IV, "24h").title, "Interview tomorrow · Acme, Inc.");
});

test("sendInterviewReminders: idempotent claim, respects push opt-out, never sends twice", async () => {
  const now = new Date("2026-11-21T10:00:00Z");
  const at = (ms) => new Date(now.getTime() + ms).toISOString();
  const mailDb = createFakeDb({
    aa_interviews: [
      { id: 1, mail_event_id: 1, user_id: U1, company: "Acme", starts_at: at(20 * H), reminder_24h_at: null, reminder_1h_at: null },
      { id: 2, mail_event_id: 2, user_id: U1, company: "Beta", starts_at: at(30 * 60 * 1000), reminder_24h_at: null, reminder_1h_at: null },
      { id: 3, mail_event_id: 3, user_id: U1, company: "Later", starts_at: at(40 * H), reminder_24h_at: null, reminder_1h_at: null },
      { id: 4, mail_event_id: 4, user_id: U2, company: "Muted", starts_at: at(2 * H), reminder_24h_at: null, reminder_1h_at: null },
      { id: 5, mail_event_id: 5, user_id: U1, company: "Past", starts_at: at(-H), reminder_24h_at: null, reminder_1h_at: null },
      { id: 6, mail_event_id: 6, user_id: U1, company: "Unset", starts_at: null },
    ],
  });
  const db = createFakeDb({ aa_profiles: [{ user_id: U1, alert_prefs: { push: true } }, { user_id: U2, alert_prefs: { push: false } }] });
  const sent = [];
  const send = async ({ userId, payload, prefs }) => {
    if (prefs && prefs.push === false) return { sent: 0, removed: 0, skipped: "opted_out" };
    sent.push({ userId, tag: payload.tag });
    return { sent: 1, removed: 0 };
  };
  const r1 = await sendInterviewReminders({ db, mailDb, now, send });
  assert.deepEqual(sent.map((s) => s.tag).sort(), ["aa-iv-1-24h", "aa-iv-2-1h"]);
  assert.equal(r1.sent, 2);
  assert.equal(r1.skipped, 1, "opted-out user is claimed but not pushed");
  const iv2 = mailDb.rows("aa_interviews").find((r) => r.id === 2);
  assert.ok(iv2.reminder_1h_at && iv2.reminder_24h_at, "missed 24 h slot stamped too");
  // overlapping / repeated runs send nothing new
  const r2 = await runInterviewReminders({ db, mailDb, now, send });
  assert.equal(r2.sent, 0);
  assert.equal(sent.length, 2);
  // 19 h later interview 1 is within 1 h -> its 1 h reminder goes, once
  const later = new Date(now.getTime() + 19.5 * H);
  await sendInterviewReminders({ db, mailDb, now: later, send });
  await sendInterviewReminders({ db, mailDb, now: later, send });
  assert.deepEqual(sent.map((s) => s.tag).filter((t) => t.startsWith("aa-iv-1-")), ["aa-iv-1-24h", "aa-iv-1-1h"]);
});

test("sendInterviewReminders: a run that loses the claim does not push", async () => {
  const now = new Date("2026-11-21T10:00:00Z");
  const mailDb = createFakeDb({ aa_interviews: [{ id: 9, mail_event_id: 9, user_id: U1, starts_at: new Date(now.getTime() + 5 * H).toISOString(), reminder_24h_at: null, reminder_1h_at: null }] });
  const db = createFakeDb();
  // another runner stamps the row between this run's select and its claim
  const racing = {
    from: (t) => {
      const b = mailDb.from(t);
      const upd = b.update;
      b.update = (patch) => {
        mailDb.rows("aa_interviews")[0].reminder_24h_at = "2026-11-21T10:00:00Z";
        return upd.call(b, patch);
      };
      return b;
    },
  };
  const sends = [];
  const second = await sendInterviewReminders({ db, mailDb: racing, now, send: async (a) => { sends.push(a); return { sent: 1 }; } });
  assert.equal(second.sent, 0);
  assert.equal(second.claimed_elsewhere, 1);
  assert.equal(sends.length, 0);
});

// ── must-apply companies ────────────────────────────────────────────────────
test("normMustCompanies: <= 10, trimmed, <= 80 chars, de-duplicated", () => {
  assert.deepEqual(normMustCompanies(undefined), { ok: true, value: [] });
  assert.deepEqual(normMustCompanies(["  Stripe ", "stripe", "", "Infosys"]), { ok: true, value: ["Stripe", "Infosys"] });
  assert.deepEqual(normMustCompanies("Acme, Beta\nGamma"), { ok: true, value: ["Acme", "Beta", "Gamma"] });
  assert.equal(normMustCompanies(Array.from({ length: 11 }, (_, i) => `C${i}`)).ok, false);
  assert.equal(normMustCompanies(Array.from({ length: 10 }, (_, i) => `C${i}`)).ok, true);
  assert.equal(normMustCompanies(["x".repeat(81)]).ok, false);
  assert.equal(normMustCompanies(["x".repeat(80)]).ok, true);
  assert.equal(normMustCompanies([1, 2]).ok, false);
  assert.equal(normMustCompanies({ a: 1 }).ok, false);
});

test("companyKey / sameCompany", () => {
  assert.equal(companyKey("Acme Technologies Pvt. Ltd."), "acme");
  assert.equal(companyKey("Tata Consultancy Services"), "tataconsultancy");
  assert.ok(sameCompany("Acme", "ACME Inc"));
  assert.ok(!sameCompany("Acme", "Beta"));
  assert.ok(!sameCompany("", "Beta"));
});

// ── insights ────────────────────────────────────────────────────────────────
test("chargeSummary: applied vs not charged by reason", () => {
  const s = chargeSummary([
    { status: "applied" }, { status: "applied" },
    { status: "failed", reason_code: "site_error" },
    { status: "needs_you", reason_code: "captcha" },
    { status: "skipped", reason_code: "sso" },
    { status: "skipped", reason_code: "job_closed" },
    { status: "queued" }, { status: "removed" }, { status: "cancelled" },
  ]);
  assert.deepEqual(s, { applied: 2, not_charged: 4, in_progress: 1, by_reason: { failed: 1, captcha: 1, blocked: 1, other: 1 } });
});

test("matchConfirmationMails: same company, after the submit, one mail per task", () => {
  const t0 = Date.parse("2026-11-20T10:00:00Z");
  const iso = (ms) => new Date(t0 + ms).toISOString();
  const tasks = [
    { id: "t1", status: "applied", company: "Acme", submitted_at: iso(0) },
    { id: "t2", status: "applied", company: "Acme", submitted_at: iso(2 * H) },
    { id: "t3", status: "applied", company: "Beta", submitted_at: iso(0) },
    { id: "t4", status: "failed", company: "Gamma", submitted_at: null },
  ];
  const mails = [
    { id: 1, category: "received", company: "Acme Inc", received_at: iso(5 * 60 * 1000) },
    { id: 2, category: "received", company: "ACME", received_at: iso(2 * H + 60 * 1000) },
    { id: 3, category: "important", company: "Beta", received_at: iso(H) },
    { id: 4, category: "received", company: "Beta", received_at: iso(5 * 86400000) },
    { id: 5, category: "received", company: "Gamma", received_at: iso(H) },
  ];
  const m = matchConfirmationMails(tasks, mails);
  assert.equal(m.get("t1").id, 1);
  assert.equal(m.get("t2").id, 2);
  assert.equal(m.has("t3"), false, "only 'received' mail within 3 days confirms");
  assert.equal(m.has("t4"), false);
});

test("roleFamily", () => {
  assert.equal(roleFamily("Senior Backend Engineer"), "backend");
  assert.equal(roleFamily("Software Engineer - Frontend (React)"), "frontend");
  assert.equal(roleFamily("Full Stack Developer"), "fullstack");
  assert.equal(roleFamily("Machine Learning Engineer"), "ml_ai");
  assert.equal(roleFamily("Data Analyst"), "data");
  assert.equal(roleFamily("Site Reliability Engineer"), "devops_sre");
  assert.equal(roleFamily("SDE II"), "software");
  assert.equal(roleFamily("Product Manager"), "product_manager");
  assert.equal(roleFamily("Chef"), "other");
});

test("replyStats: totals and per role family, last 90 days, rates bounded, no per-company table", () => {
  const now = new Date("2026-11-21T00:00:00Z");
  const d = (days) => new Date(now.getTime() - days * 86400000).toISOString();
  const tasks = [
    { id: "a1", company: "Acme", title: "Backend Engineer", status: "applied", submitted_at: d(10) },
    { id: "a2", company: "Acme", title: "Frontend Engineer", status: "applied", submitted_at: d(5) },
    { id: "b1", company: "Beta", title: "Backend Engineer", status: "applied", submitted_at: d(20) },
    { id: "c1", company: "Old Co", title: "Backend Engineer", status: "applied", submitted_at: d(120) },
  ];
  const mails = [
    { id: 1, company: "Acme Inc", category: "important", kind: "interview", received_at: d(4) },
    { id: 2, company: "Acme", category: "important", kind: "recruiter", received_at: d(3) },
    { id: 3, company: "Beta", category: "rejected", kind: "rejection", received_at: d(15) },
    { id: 4, company: "Beta", category: "received", received_at: d(19) },
    { id: 5, company: "Old Co", category: "important", received_at: d(100) },
    { id: 6, company: "Nobody", category: "important", received_at: d(1) },
  ];
  const s = replyStats({ tasks, mails, interviews: [{ mail_event_id: 1, company: "Acme" }], now });
  assert.equal(s.window_days, 90);
  assert.deepEqual(s.totals, { applied: 3, replies: 2, interviews: 1, rejections: 1, rate: 66.7, interview_rate: 33.3 }, "Old Co is older than 90 days");
  assert.equal("by_company" in s, false, "the stats page has no By company section; the server no longer computes it");
  const be = s.by_role.find((r) => r.key === "backend");
  assert.deepEqual([be.applied, be.replies], [2, 1], "Beta's rejection; Acme's mail goes to the latest Acme task (frontend)");
  const fe = s.by_role.find((r) => r.key === "frontend");
  assert.deepEqual([fe.applied, fe.replies, fe.interviews], [1, 1, 1]);
  for (const r of s.by_role) assert.ok(r.rate >= 0 && r.rate <= 100);
});

// ── health / admin ──────────────────────────────────────────────────────────
test("health: stale after 2 x interval, error wins, summary order", () => {
  const now = new Date("2026-11-21T10:00:00Z");
  const ago = (s) => new Date(now.getTime() - s * 1000).toISOString();
  assert.equal(healthView({ component: "scheduler", status: "ok", last_seen: ago(500), stats: {} }, now).level, "ok");
  assert.equal(healthView({ component: "scheduler", status: "ok", last_seen: ago(700), stats: {} }, now).level, "stale");
  assert.equal(healthView({ component: "worker:vm1", status: "ok", last_seen: ago(100), stats: { interval_s: 60 } }, now).stale, false);
  assert.equal(healthView({ component: "worker:vm1", status: "ok", last_seen: ago(130), stats: { interval_s: 60 } }, now).stale, true);
  assert.equal(healthView({ component: "discovery", status: "error", last_seen: ago(10), stats: { reason: "zero_jobs" } }, now).level, "error");
  assert.equal(healthView({ component: "discovery", status: "warn", last_seen: ago(10), stats: {} }, now).level, "warn");
  const s = healthSummary([
    { component: "worker:b", status: "ok", last_seen: ago(10), stats: { interval_s: 60 } },
    { component: "discovery", status: "error", last_seen: ago(10), stats: {} },
    { component: "scheduler", status: "ok", last_seen: ago(9999), stats: {} },
  ], now);
  assert.deepEqual(s.components.map((c) => c.component), ["discovery", "scheduler", "worker:b"]);
  assert.deepEqual(s.counts, { ok: 1, warn: 0, stale: 1, error: 1 });
  assert.equal(s.ok, false);
});

test("isAdminUser: env allowlist by email or id, nobody by default", () => {
  assert.equal(isAdminUser({ id: U1, email: "a@x.com" }, {}), false);
  assert.equal(isAdminUser({ id: U1, email: "Boss@X.com", email_confirmed: true }, { AA_ADMIN_EMAILS: "boss@x.com, other@y.com" }), true);
  assert.equal(isAdminUser({ id: U1, email: "Boss@X.com" }, { AA_ADMIN_EMAILS: "boss@x.com" }), false, "unconfirmed email");
  assert.equal(isAdminUser({ id: U1, email: "boss@x.com", email_confirmed: true }, { AA_ADMIN_EMAILS: "boss@x.com", AA_ADMIN_USER_IDS: "someone-else" }), false, "ids set: emails ignored");
  assert.equal(isAdminUser({ id: U1, email: null }, { AA_ADMIN_USER_IDS: U1.toUpperCase() }), true);
  assert.equal(isAdminUser(null, { AA_ADMIN_EMAILS: "a@x.com" }), false);
});

// ── mail dedupe ─────────────────────────────────────────────────────────────
test("mailDedupeKey: per recipient + Message-ID; stable fallback for a retried payload", () => {
  const p = { to: "priya.k7q2@apply.vloombox.in", from: "a@b.com", subject: "Hi", received_at: "2026-11-21T10:00:00Z", raw_key: "mail/2026/11/21/x.eml", message_id: "<ABC@mail.test>" };
  assert.match(mailDedupeKey(p), /^[0-9a-f]{64}$/);
  assert.equal(mailDedupeKey(p), mailDedupeKey({ ...p, message_id: "abc@mail.test", received_at: "2026-11-21T10:05:00Z" }), "same Message-ID, retry");
  assert.notEqual(mailDedupeKey(p), mailDedupeKey({ ...p, to: "other.zz11@apply.vloombox.in" }), "other recipient");
  const noMid = { ...p, message_id: null };
  assert.equal(mailDedupeKey(noMid), mailDedupeKey({ ...noMid }));
  assert.notEqual(mailDedupeKey(noMid), mailDedupeKey({ ...noMid, raw_key: "mail/2026/11/21/y.eml" }));
});

test("storeInbound: a retried mail inserts nothing and reports duplicate; missing column falls back", async () => {
  const db = createFakeDb({ aa_profiles: [{ user_id: U1, apply_alias: "priya.k7q2", alert_prefs: {} }] });
  const mailDb = createFakeDb();
  const payload = { to: "priya.k7q2@apply.vloombox.in", from: "jane@acme.com", from_name: "Jane", subject: "Interview with Acme", is_human: true, text_excerpt: "Can we talk tomorrow?", message_id: "<x1>", received_at: new Date().toISOString(), auth: { dmarc: "pass" } };
  const a = await storeInbound({ db, mailDb, payload });
  assert.equal(a.duplicate, false);
  assert.ok(a.event.dedupe_key);
  const b = await storeInbound({ db, mailDb, payload });
  assert.equal(b.duplicate, true);
  assert.equal(b.event, null);
  assert.equal(mailDb.rows("aa_mail_events").length, 1);
  assert.equal(mailDb.rpcCalls.length, 1, "notify only for the first delivery");

  // a mail db without dedupe_key yet: PostgREST rejects the column -> plain insert
  const old = createFakeDb();
  const from = old.from;
  old.from = (t) => {
    const qb = from(t);
    const upsert = qb.upsert;
    qb.upsert = () => { upsert.call(qb, {}); qb.then = (res) => Promise.resolve({ data: null, error: { code: "PGRST204", message: "Could not find the 'dedupe_key' column" } }).then(res); return qb; };
    return qb;
  };
  const c = await storeInbound({ db, mailDb: old, payload });
  assert.equal(c.duplicate, false);
  assert.equal(old.rows("aa_mail_events").length, 1);
  assert.equal(old.rows("aa_mail_events")[0].dedupe_key, undefined);
});

// ── API ─────────────────────────────────────────────────────────────────────
const ADMIN = "bbbbbbbb-0000-4000-8000-0000000000ad";
const USERS = { [U1]: "pro", [U2]: "pro", [ADMIN]: "max" };
const BATCH = crypto.randomUUID();
const OTHER_BATCH = crypto.randomUUID();
const T_APPLIED = crypto.randomUUID();
const T_NOPROOF = crypto.randomUUID();
const T_FAILED = crypto.randomUUID();
const T_OTHER = crypto.randomUUID();
const T_EVIL = crypto.randomUUID();
const now = new Date();
const iso = (ms) => new Date(now.getTime() + ms).toISOString();

const db = createFakeDb({
  aa_profiles: [{ user_id: U1, apply_alias: "priya.k7q2", onboarding_done: true, consent_at: new Date().toISOString(), alert_prefs: {} }],
  aa_batches: [
    { id: BATCH, user_id: U1, pack_kind: "product", pack_size: 50, credits_total: 50, credits_used: 1, status: "running", purchased_at: iso(-86400000), must_companies: [] },
    { id: OTHER_BATCH, user_id: U2, pack_kind: "product", pack_size: 50, credits_total: 50, status: "running", purchased_at: iso(-86400000) },
  ],
  aa_tasks: [
    { id: T_APPLIED, batch_id: BATCH, user_id: U1, company: "Acme", title: "Backend Engineer", status: "applied", score: 90, submitted_at: iso(-3 * H), proof_path: `${U1}/${T_APPLIED}.png`, confirmation_text: "Thank you for applying to Acme!", not_charged: false },
    { id: T_NOPROOF, batch_id: BATCH, user_id: U1, company: "Beta", title: "Data Engineer", status: "applied", score: 80, submitted_at: iso(-2 * H), proof_path: null },
    { id: T_FAILED, batch_id: BATCH, user_id: U1, company: "Gamma", title: "SRE", status: "needs_you", reason_code: "captcha", score: 70, not_charged: true },
    { id: T_EVIL, batch_id: BATCH, user_id: U1, company: "Evil", title: "x", status: "applied", score: 1, submitted_at: iso(-H), proof_path: `${U2}/stolen.png` },
    { id: T_OTHER, batch_id: OTHER_BATCH, user_id: U2, company: "Acme", title: "x", status: "applied", score: 1, submitted_at: iso(-H), proof_path: `${U2}/${crypto.randomUUID()}.png` },
  ],
  aa_jobs: [
    { company: "Stripe", company_kind: "product", closed_at: null },
    { company: "Stripe", company_kind: "product", closed_at: null },
    { company: "Instripe Labs", company_kind: "product", closed_at: null },
    { company: "Strip Closed", company_kind: "product", closed_at: iso(-H) },
    { company: "Stride Services", company_kind: "service", closed_at: null },
  ],
  aa_health: [
    { component: "scheduler", status: "ok", last_seen: iso(-60 * 1000), stats: { interval_s: 300 } },
    { component: "discovery", status: "error", last_seen: iso(-60 * 1000), stats: { reason: "zero_jobs" } },
  ],
});
const mailDb = createFakeDb({
  aa_mail_events: [
    { id: 501, user_id: U1, category: "received", company: "Acme", subject: "We received your application", from_name: "Acme Careers", sender: "no-reply@acme.com", received_at: iso(-3 * H + 60 * 1000) },
    { id: 502, user_id: U2, category: "received", company: "Beta", subject: "Not yours", received_at: iso(-2 * H + 60 * 1000) },
    { id: 503, user_id: U1, category: "important", kind: "interview", company: "Acme", subject: "Interview", received_at: iso(-H) },
  ],
  aa_interviews: [{ id: 1, mail_event_id: 503, user_id: U1, company: "Acme", starts_at: iso(48 * H) }],
});

const razorpay = {
  isEnabled: () => true,
  keyId: () => "rzp_test_key",
  async createOrder({ amountPaise, currency, notes }) { return { id: `order_${crypto.randomBytes(4).toString("hex")}`, amount: amountPaise, currency, notes }; },
};
const pushes = [];
let lastAfter = null;
const SECRET = "feat-secret";
let server;
let base;

before(async () => {
  const app = express();
  app.post("/api/inbound/email", express.raw({ type: () => true }), createInboundHandler({ db, mailDb, getSecret: () => SECRET, sendPush: async (a) => { pushes.push(a); return { sent: 1 }; }, onAfter: (p) => (lastAfter = p) }));
  app.use(express.json());
  app.use(
    "/api/autoapply",
    createAutoApplyRouter({
      db,
      mailDb,
      razorpay,
      env: { AA_ADMIN_EMAILS: "admin@vloombox.test" },
      getUserPlan: async (uid) => USERS[uid] || "free",
      authenticate: (req, res, next) => {
        const uid = String(req.headers.authorization || "").replace(/^Bearer /, "");
        if (!USERS[uid]) return res.status(401).json({ error: { code: "auth_required", message: "x" } });
        req.user = { id: uid, email: uid === ADMIN ? "admin@vloombox.test" : `${uid.slice(-4)}@mail.test`, email_confirmed: true };
        next();
      },
    }),
  );
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

async function call(method, path, { user = U1, body, headers = {}, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(user ? { Authorization: `Bearer ${user}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers };
}

test("GET /me: readiness score and is_admin", async () => {
  const r = await call("GET", "/api/autoapply/me");
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.readiness.pct, "number");
  assert.equal(r.json.readiness.ok, r.json.profile_check.ok);
  assert.deepEqual(r.json.readiness.missing.map((m) => m.key), r.json.profile_check.missing.map((m) => m.key));
  assert.ok(r.json.readiness.missing.every((m) => m.fix.startsWith("/autoapply/setup?step=")));
  assert.equal(r.json.is_admin, false);
  assert.equal((await call("GET", "/api/autoapply/me", { user: ADMIN })).json.is_admin, true);
});

test("GET /batches/:id: charge summary, confirmation text, has_proof (no path), matched confirmation mail", async () => {
  const r = await call("GET", `/api/autoapply/batches/${BATCH}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.charge, { applied: 3, not_charged: 1, in_progress: 0, by_reason: { failed: 0, captcha: 1, blocked: 0, other: 0 } });
  const t = r.json.tasks.find((x) => x.id === T_APPLIED);
  assert.equal(t.confirmation_text, "Thank you for applying to Acme!");
  assert.equal(t.has_proof, true);
  assert.equal("proof_path" in t, false);
  assert.deepEqual(t.confirmation_mail, { id: 501, subject: "We received your application", from_name: "Acme Careers", received_at: mailDb.rows("aa_mail_events")[0].received_at });
  const beta = r.json.tasks.find((x) => x.id === T_NOPROOF);
  assert.equal(beta.has_proof, false);
  assert.equal(beta.confirmation_mail, null, "another user's mail never matches");
});

test("GET /batches/:id/tasks/:taskId/proof: owner only, 5-minute signed URL from aa-proof", async () => {
  const r = await call("GET", `/api/autoapply/batches/${BATCH}/tasks/${T_APPLIED}/proof`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.expires_in, 300);
  assert.match(r.json.url, new RegExp(`aa-proof/${U1}/${T_APPLIED}\\.png`));
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(db.storage.calls.at(-1), { op: "sign", bucket: "aa-proof", path: `${U1}/${T_APPLIED}.png`, expiresIn: 300 });

  const signs = () => db.storage.calls.filter((c) => c.op === "sign").length;
  const n = signs();
  assert.equal((await call("GET", `/api/autoapply/batches/${BATCH}/tasks/${T_NOPROOF}/proof`)).status, 404, "no proof saved");
  assert.equal((await call("GET", `/api/autoapply/batches/${BATCH}/tasks/${T_EVIL}/proof`)).status, 404, "path outside the owner's folder");
  assert.equal((await call("GET", `/api/autoapply/batches/${OTHER_BATCH}/tasks/${T_OTHER}/proof`)).status, 404, "someone else's batch");
  assert.equal((await call("GET", `/api/autoapply/batches/${BATCH}/tasks/${T_OTHER}/proof`)).status, 404, "task of another batch");
  assert.equal((await call("GET", `/api/autoapply/batches/${OTHER_BATCH}/tasks/${T_OTHER}/proof`, { user: U2 })).status, 200);
  assert.equal(signs(), n + 1, "only the legitimate request was signed");
  assert.equal((await call("GET", `/api/autoapply/batches/${BATCH}/tasks/not-a-uuid/proof`)).status, 404);
  assert.equal((await call("GET", `/api/autoapply/batches/${BATCH}/tasks/${T_APPLIED}/proof`, { user: null })).status, 401);
});

test("PUT /batches/:id/must-companies: validated server-side, owner only, active batches only", async () => {
  const ok = await call("PUT", `/api/autoapply/batches/${BATCH}/must-companies`, { body: { must_companies: [" Stripe ", "stripe", "Infosys"] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(ok.json.batch.must_companies, ["Stripe", "Infosys"]);
  const tooMany = await call("PUT", `/api/autoapply/batches/${BATCH}/must-companies`, { body: { must_companies: Array.from({ length: 11 }, (_, i) => `C${i}`) } });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.json.error.code, "invalid_input");
  assert.equal((await call("PUT", `/api/autoapply/batches/${BATCH}/must-companies`, { body: { must_companies: ["x".repeat(81)] } })).status, 400);
  assert.equal((await call("PUT", `/api/autoapply/batches/${OTHER_BATCH}/must-companies`, { body: { must_companies: ["A"] } })).status, 404);
  db.rows("aa_batches").push({ id: crypto.randomUUID(), user_id: U1, status: "completed", credits_total: 50 });
  const done = db.rows("aa_batches").at(-1);
  assert.equal((await call("PUT", `/api/autoapply/batches/${done.id}/must-companies`, { body: { must_companies: ["A"] } })).status, 409);
  assert.deepEqual(db.rows("aa_batches").find((b) => b.id === BATCH).must_companies, ["Stripe", "Infosys"]);
});

test("POST /orders: must_companies saved on the new batch, invalid input rejected before any order", async () => {
  const n = db.rows("aa_batches").length;
  const bad = await call("POST", "/api/autoapply/orders", { body: { pack_kind: "product", pack_size: 50, window_days: 3, must_companies: Array.from({ length: 11 }, (_, i) => `C${i}`) } });
  assert.equal(bad.status, 400);
  assert.equal(db.rows("aa_batches").length, n, "no batch created for invalid input");
  const r = await call("POST", "/api/autoapply/orders", { body: { pack_kind: "product", pack_size: 50, window_days: 3, must_companies: ["Stripe", " Razorpay "] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.must_companies, ["Stripe", "Razorpay"]);
  assert.deepEqual(db.rows("aa_batches").find((b) => b.id === r.json.batch_id).must_companies, ["Stripe", "Razorpay"]);
});

test("GET /companies/suggest: open jobs, distinct, prefix first, kind filter", async () => {
  const r = await call("GET", "/api/autoapply/companies/suggest?q=stri");
  assert.deepEqual(r.json.companies, ["Stride Services", "Stripe", "Instripe Labs"].sort((a, b) => Number(!a.toLowerCase().startsWith("stri")) - Number(!b.toLowerCase().startsWith("stri")) || a.localeCompare(b)));
  assert.deepEqual((await call("GET", "/api/autoapply/companies/suggest?q=stri&kind=product")).json.companies, ["Stripe", "Instripe Labs"]);
  assert.deepEqual((await call("GET", "/api/autoapply/companies/suggest?q=s")).json.companies, []);
  assert.equal((await call("GET", "/api/autoapply/companies/suggest?q=stri&kind=bogus")).status, 400);
});

test("GET /stats/replies: own data only, last 90 days", async () => {
  const r = await call("GET", "/api/autoapply/stats/replies");
  assert.equal(r.status, 200);
  assert.equal(r.json.window_days, 90);
  assert.equal("by_company" in r.json, false);
  assert.ok(r.json.by_role.length >= 1);
  assert.ok(r.json.totals.replies >= 1 && r.json.totals.interviews >= 1, "Acme's interview mail counts for U1");
  const other = await call("GET", "/api/autoapply/stats/replies", { user: U2 });
  assert.equal(other.json.totals.replies, 0);
});

test("GET /admin/health: admin only, stale / error highlighted", async () => {
  const denied = await call("GET", "/api/autoapply/admin/health");
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, "forbidden");
  const r = await call("GET", "/api/autoapply/admin/health", { user: ADMIN });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.components.map((c) => [c.component, c.level]), [["discovery", "error"], ["scheduler", "ok"]]);
  assert.equal(r.json.ok, false);
});

function signed(obj, ts = Math.floor(Date.now() / 1000)) {
  const raw = Buffer.from(JSON.stringify(obj));
  return { raw, headers: { "Content-Type": "application/json", "X-AA-Timestamp": String(ts), "X-AA-Signature": signInbound(SECRET, String(ts), raw) } };
}

test("inbound: a retried delivery is stored once and pushed once", async () => {
  const mail = { to: "priya.k7q2@apply.vloombox.in", from: "jane@acme.com", from_name: "Jane at Acme", subject: "Interview invitation", is_human: true, codes: [], links: [], text_excerpt: "We would like to schedule an interview.", received_at: new Date().toISOString(), raw_key: "mail/r.eml", message_id: "<retry-1@acme.com>" };
  const n0 = mailDb.rows("aa_mail_events").length;
  const a = signed(mail);
  const r1 = await call("POST", "/api/inbound/email", { user: null, raw: a.raw, headers: a.headers });
  assert.deepEqual(r1.json, { ok: true });
  await lastAfter;
  const b = signed(mail);
  const r2 = await call("POST", "/api/inbound/email", { user: null, raw: b.raw, headers: b.headers });
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.json, { ok: true, duplicate: true });
  await lastAfter;
  assert.equal(mailDb.rows("aa_mail_events").length, n0 + 1);
  assert.equal(pushes.length, 1);
});

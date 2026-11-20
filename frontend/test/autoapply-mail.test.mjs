/**
 * AutoApply mail: classifier, retention cleanup, daily alert batching, web push. No network.
 * Run: npm run test:autoapply
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyMail, expiresAtFor, RETENTION_DAYS } from "../lib/autoapply/classify.js";
import { cleanupExpiredMail, sendDailyAlerts, buildAlertEmail, describeAlert } from "../lib/autoapply/mailJobs.js";
import { sendPushForMail, pushPayload, vapidConfig } from "../lib/autoapply/push.js";
import { getMailDb, hasSeparateMailDb } from "../lib/autoapply/mailDb.js";
import { createFakeDb } from "./fixtures/fakeSupabase.mjs";

const cat = (m) => classifyMail(m).category;

test("classifier: codes", () => {
  assert.equal(cat({ subject: "Your verification code is 482913", codes: ["482913"], text_excerpt: "Use this verification code to continue." }), "code");
  assert.equal(cat({ subject: "Verify your email address", text_excerpt: "Click the link to verify." }), "code");
  assert.equal(cat({ subject: "Reset your password", text_excerpt: "..." }), "code");
  assert.equal(cat({ subject: "Security code", codes: ["123456"], text_excerpt: "Your one-time code: 123456" }), "code");
  assert.equal(classifyMail({ subject: "Your OTP is 123456", codes: ["123456"] }).retention_days, null, "codes are never deleted");
});

test("classifier: received confirmations", () => {
  assert.equal(cat({ subject: "Thank you for applying to Acme", text_excerpt: "We have received your application." }), "received");
  assert.equal(cat({ subject: "Application received", text_excerpt: "Our team will review it and be in touch if there is a match." }), "received");
  assert.equal(cat({ subject: "Your application", text_excerpt: "Thanks for applying! We'll review your profile." }), "received");
  assert.equal(cat({ subject: "You have successfully applied to Globex", text_excerpt: "Track your application in your candidate home." }), "received");
  assert.equal(cat({ subject: "Applied successfully", text_excerpt: "Your application for Data Analyst was sent." }), "received");
  assert.equal(classifyMail({ subject: "Thanks for applying" }).retention_days, 30);
});

test("classifier: important", () => {
  assert.equal(cat({ subject: "Complete your online assessment", text_excerpt: "Please finish the test within 3 days." }), "important");
  assert.equal(cat({ subject: "HackerRank test invitation", text_excerpt: "x" }), "important");
  assert.equal(cat({ subject: "Interview invitation - Backend Engineer", text_excerpt: "" }), "important");
  assert.equal(cat({ subject: "Your offer letter", text_excerpt: "" }), "important");
  assert.equal(cat({ subject: "Next steps for your application", text_excerpt: "" }), "important");
  assert.equal(cat({ subject: "Hello", text_excerpt: "Hi, quick question about your profile", is_human: true }), "important");
  assert.equal(classifyMail({ subject: "Online assessment" }).retention_days, null);
});

test("classifier: strong important beats code/received; unsure is never code/received", () => {
  // a code mail that is really an assessment invite
  assert.equal(cat({ subject: "Verify your email to start your coding assessment", codes: ["123456"] }), "important");
  // a confirmation that mentions an interview is kept long
  assert.equal(cat({ subject: "Thank you for applying", text_excerpt: "If shortlisted we will call you for an interview." }), "important");
  // a person writing is never code/received, even with code-like words
  assert.equal(cat({ subject: "Thank you for applying", text_excerpt: "Hi Priya, I'm Jane from the team", is_human: true }), "important");
  assert.equal(cat({ subject: "Verify your email", is_human: true }), "important");
  // unrelated newsletter, "background verification" and the like: other
  assert.equal(cat({ subject: "Weekly digest from Globex", text_excerpt: "news" }), "other");
  assert.equal(cat({ subject: "Employment verification form", text_excerpt: "Please upload documents" }), "other");
  assert.equal(cat({}), "other");
  assert.deepEqual(RETENTION_DAYS, { code: null, received: 30, rejected: 30, important: null, other: null });
});

test("classifier: expiresAtFor", () => {
  const t = new Date("2026-01-01T00:00:00Z");
  assert.equal(expiresAtFor("code", t), null);
  assert.equal(expiresAtFor("received", t), "2026-01-31T00:00:00.000Z");
  assert.equal(expiresAtFor("rejected", t), "2026-01-31T00:00:00.000Z");
  assert.equal(expiresAtFor("important", t), null);
  assert.equal(expiresAtFor("other", t), null);
  assert.equal(expiresAtFor("bogus", t), null);
});

// ── cleanup ────────────────────────────────────────────────────────────────
const now = new Date("2026-11-17T00:00:00Z");
const iso = (offsetMs) => new Date(now.getTime() + offsetMs).toISOString();
const row = (over) => ({ user_id: "u1", alias: "a.b", sender: "x@y.com", subject: "s", codes: [], links: [], is_human: false, text_excerpt: "", category: "received", received_at: iso(-1000), expires_at: iso(86400000), ...over });

test("cleanup: deletes only expired rows, in batches", async () => {
  const mailDb = createFakeDb({
    aa_mail_events: [
      ...Array.from({ length: 7 }, (_, i) => row({ id: 100 + i, expires_at: iso(-1000 * (i + 1)) })),
      row({ id: 107, category: "rejected", expires_at: iso(-5000) }),
      row({ id: 200 }),
      row({ id: 201, category: "important", expires_at: null }),
      row({ id: 202, category: "code", expires_at: null }),
      row({ id: 203, category: "other", expires_at: null }),
      // legacy rows that still carry an old expiry: never deleted unless received / rejected
      row({ id: 204, category: "important", expires_at: iso(-5000) }),
      row({ id: 205, category: "code", expires_at: iso(-5000) }),
      row({ id: 206, category: "other", expires_at: iso(-5000) }),
    ],
  });
  const r = await cleanupExpiredMail({ mailDb, now, batchSize: 3 });
  assert.deepEqual(r, { deleted: 8 });
  assert.deepEqual(mailDb.rows("aa_mail_events").map((x) => x.id).sort(), [200, 201, 202, 203, 204, 205, 206]);
  assert.deepEqual(await cleanupExpiredMail({ mailDb, now }), { deleted: 0 });
});

// ── daily alerts ───────────────────────────────────────────────────────────
const U = (n) => `bbbbbbbb-0000-4000-8000-00000000000${n}`;

function alertFixture(extraProfiles = []) {
  const db = createFakeDb({
    aa_profiles: [
      { user_id: U(1), contact_email: "one@example.com", apply_alias: "one.aaaa" },
      { user_id: U(2), contact_email: null, apply_alias: "two.bbbb" },
      { user_id: U(3), contact_email: "three@example.com", apply_alias: "three.cccc", alert_prefs: { email: false, push: true } },
      ...extraProfiles,
    ],
  });
  const mailDb = createFakeDb({
    aa_mail_events: [
      row({ id: 1, user_id: U(1), category: "important", sender: "recruit@ibm.com", subject: "Online assessment for Backend Engineer", received_at: iso(-3600000) }),
      row({ id: 2, user_id: U(1), category: "important", sender: "hr@ibm.com", subject: "Interview schedule", received_at: iso(-7200000) }),
      row({ id: 3, user_id: U(1), category: "other", subject: "newsletter" }),                                    // not important
      row({ id: 4, user_id: U(1), category: "important", alerted_at: iso(-5000), received_at: iso(-3600000) }),   // already alerted
      row({ id: 5, user_id: U(1), category: "important", received_at: iso(-30 * 3600000) }),                      // older than 24 h
      row({ id: 6, user_id: U(2), category: "important", sender: "x@hirevue.com", subject: "Your HireVue test", received_at: iso(-1000) }),
      row({ id: 7, user_id: U(3), category: "important", received_at: iso(-1000) }),                              // email alerts off
      row({ id: 8, user_id: null, category: "important", received_at: iso(-1000) }),                              // unknown alias
    ],
  });
  return { db, mailDb };
}

test("daily alerts: one email per user, no body, respects prefs, marks alerted_at", async () => {
  const { db, mailDb } = alertFixture();
  const sent = [];
  const resend = { async sendEmail(m) { sent.push(m); return { id: `re_${sent.length}` }; } };
  const stats = await sendDailyAlerts({ db, mailDb, resend, getAuthEmail: async (uid) => (uid === U(2) ? "two-auth@example.com" : null), baseUrl: "https://app.test/", now });
  assert.deepEqual(stats, { users: 3, sent: 2, skipped: 1, failed: 0, deferred: 0 });
  assert.equal(sent.length, 2);
  const one = sent.find((m) => m.to === "one@example.com");
  assert.equal(one.subject, "You have 2 new messages in Vloombox");
  assert.match(one.text, /\(e\.g\. 1 assessment from Ibm\)/);
  assert.match(one.text, /Open: https:\/\/app\.test\/autoapply\/inbox$/);
  assert.doesNotMatch(one.text + one.html, /Backend Engineer|Interview schedule/, "subjects and bodies are never included");
  const two = sent.find((m) => m.to === "two-auth@example.com");
  assert.ok(two, "falls back to the auth email when there is no contact_email");
  assert.equal(two.subject, "You have 1 new message in Vloombox");

  const by = (id) => mailDb.rows("aa_mail_events").find((r) => r.id === id);
  for (const id of [1, 2, 6, 7]) assert.ok(by(id).alerted_at, `mail ${id} marked alerted`);
  assert.equal(by(3).alerted_at ?? null, null);
  assert.equal(by(5).alerted_at ?? null, null, "older than 24 h is never alerted");
  assert.equal(by(8).alerted_at ?? null, null);

  // second run: nothing left to send
  const again = await sendDailyAlerts({ db, mailDb, resend, now });
  assert.equal(again.sent, 0);
  assert.equal(sent.length, 2);
});

test("daily alerts: send cap per run, leftovers wait; failures stay unalerted", async () => {
  const profiles = [];
  const events = [];
  for (let i = 0; i < 5; i++) {
    const uid = `cccccccc-0000-4000-8000-00000000000${i}`;
    profiles.push({ user_id: uid, contact_email: `u${i}@example.com`, apply_alias: `u${i}.aaaa` });
    events.push(row({ id: 500 + i, user_id: uid, category: "important", received_at: iso(-1000 * (i + 1)) }));
  }
  const db = createFakeDb({ aa_profiles: profiles });
  const mailDb = createFakeDb({ aa_mail_events: events });
  const sent = [];
  const resend = { async sendEmail(m) { sent.push(m); return { id: "ok" }; } };
  const s1 = await sendDailyAlerts({ db, mailDb, resend, now, maxSends: 3 });
  assert.equal(s1.sent, 3);
  assert.equal(s1.deferred, 2);
  assert.equal(mailDb.rows("aa_mail_events").filter((r) => r.alerted_at).length, 3);
  const s2 = await sendDailyAlerts({ db, mailDb, resend, now, maxSends: 3 });
  assert.equal(s2.sent, 2);
  assert.equal(new Set(sent.map((m) => m.to)).size, 5, "every user got exactly one email");

  const failing = { async sendEmail() { return { error: true, status: 500 }; } };
  const f = createFakeDb({ aa_mail_events: [row({ id: 1, user_id: U(1), category: "important", received_at: iso(-1000) })] });
  const fs = await sendDailyAlerts({ db: createFakeDb({ aa_profiles: [{ user_id: U(1), contact_email: "a@b.co", apply_alias: "a.b" }] }), mailDb: f, resend: failing, now });
  assert.equal(fs.failed, 1);
  assert.equal(f.rows("aa_mail_events")[0].alerted_at ?? null, null);
});

test("alert wording", () => {
  assert.equal(buildAlertEmail({ events: [{ sender: "a@acme.com", subject: "Hello" }], baseUrl: "https://x.test" }).subject, "You have 1 new message in Vloombox");
  assert.equal(describeAlert([{ sender: "no-reply@myworkday.com", subject: "Interview" }]).example, "1 interview");
  assert.match(describeAlert([{ sender: "Jane <jane@globex.com>", subject: "Hi" }]).example, /1 message from Globex/);
});

// ── push ───────────────────────────────────────────────────────────────────
test("push: disabled without VAPID env, sends to every subscription, drops dead ones", async () => {
  assert.equal(vapidConfig({}), null);
  assert.equal(vapidConfig({ VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b" }).subject, "mailto:support.vloombox@gmail.com");
  const db = createFakeDb({
    aa_push_subscriptions: [
      { user_id: U(1), endpoint: "https://p.test/live", p256dh: "k", auth: "a" },
      { user_id: U(1), endpoint: "https://p.test/gone", p256dh: "k", auth: "a" },
      { user_id: U(2), endpoint: "https://p.test/other", p256dh: "k", auth: "a" },
    ],
  });
  const event = { id: 9, sender: "Acme HR <hr@acme.com>", subject: "Your online assessment" };
  assert.deepEqual(await sendPushForMail({ db, event, userId: U(1), env: {} }), { sent: 0, removed: 0, skipped: "disabled" });

  const calls = [];
  const webpush = {
    async sendNotification(sub, body) {
      calls.push({ sub, body: JSON.parse(body) });
      if (sub.endpoint.endsWith("/gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
    },
  };
  const r = await sendPushForMail({ db, event, userId: U(1), webpush });
  assert.deepEqual(r, { sent: 1, removed: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.body, "New message from Acme HR: Your online assessment");
  assert.equal(calls[0].body.url, "/autoapply/inbox?mail=9");
  assert.equal(calls[0].body.title, "Vloombox inbox");
  assert.equal(pushPayload({ id: 3, kind: "interview", company: "Acme", sender: "x@acme.com", subject: "Interview" }).title, "Interview invite · Acme");
  assert.equal(pushPayload({ id: 4, category: "rejected", sender: "x@acme.com", subject: "Update" }).title, "Application update");
  assert.equal(pushPayload({ id: 5, kind: "offer", sender: "x@acme.com", subject: "Offer" }).title, "Offer received");
  assert.deepEqual(db.rows("aa_push_subscriptions").map((s) => s.endpoint).sort(), ["https://p.test/live", "https://p.test/other"]);

  assert.equal((await sendPushForMail({ db, event, userId: U(1), webpush, prefs: { push: false } })).skipped, "opted_out");
  // a transient failure keeps the subscription and never throws
  const flaky = { async sendNotification() { throw Object.assign(new Error("boom"), { statusCode: 500 }); } };
  assert.deepEqual(await sendPushForMail({ db, event, userId: U(1), webpush: flaky }), { sent: 0, removed: 0 });
  assert.equal(db.rows("aa_push_subscriptions").length, 2);
  assert.equal(pushPayload({ id: 1, sender: "x@y.com", subject: null }).body, "New message from x@y.com: (no subject)");
});

test("mailDb: separate project only when both env vars are set", () => {
  assert.equal(hasSeparateMailDb({}), false);
  assert.equal(hasSeparateMailDb({ AA_MAIL_SUPABASE_URL: "https://x.supabase.co" }), false);
  assert.equal(hasSeparateMailDb({ AA_MAIL_SUPABASE_URL: "https://x.supabase.co", AA_MAIL_SUPABASE_SERVICE_ROLE_KEY: "k" }), true);
  const c = getMailDb({ AA_MAIL_SUPABASE_URL: "https://x.supabase.co", AA_MAIL_SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert.equal(typeof c.from, "function");
});

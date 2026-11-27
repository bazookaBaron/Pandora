/**
 * Inbox tagging regressions: candidate tag from rules, then a corroborating-evidence check (no AI). No network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMail, confirmKind } from "../lib/autoapply/classify.js";
import { reverifyMail } from "../lib/autoapply/mailJobs.js";
import { createFakeDb } from "./fixtures/fakeSupabase.mjs";

const ICS = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20261203T093000Z\nEND:VEVENT\nEND:VCALENDAR";

const BLACKSTONE = {
  sender: "no-reply@blackstone.wd1.myworkdayjobs.com",
  from_name: "Blackstone Careers",
  subject: "Thank you for applying to Blackstone",
  text_excerpt: "Dear Candidate, thank you for applying for the Analyst position at Blackstone. We have received your application and will review it. If your profile is a match, we will contact you to arrange an interview. Assessments may follow.",
};

test("Blackstone-style acknowledgement mentioning an interview is received, not important", () => {
  const r = classifyMail(BLACKSTONE);
  assert.equal(r.category, "received");
  assert.equal(r.kind, null);
  assert.equal(r.retention_days, 30);
});

test("acknowledgement variants stay received", () => {
  for (const [subject, text] of [
    ["Application received - Data Engineer", "We have received your application. Next steps: our team will review and, if shortlisted, schedule an interview."],
    ["Thanks for applying to Globex", "Your availability is not needed yet. The hiring manager will reach out regarding the assessment."],
    ["We received your application", "You may be invited to an online assessment later."],
  ]) {
    const r = classifyMail({ sender: "noreply@greenhouse-mail.io", subject, text_excerpt: text });
    assert.equal(r.category, "received", subject);
    assert.equal(r.kind, null);
  }
});

test("real interview invites stay interview (calendar, meeting link, scheduling phrase)", () => {
  const ics = classifyMail({ sender: "recruiter@acme.com", subject: "Invitation: Interview with Acme", text_excerpt: "Join the call.", ics: ICS, is_human: true });
  assert.deepEqual([ics.category, ics.kind, ics.kind_source], ["important", "interview", "rule_confirmed"]);
  const zoom = classifyMail({ sender: "talent@acme.com", subject: "Next round at Acme", text_excerpt: "Please join us.", meeting_links: ["https://acme.zoom.us/j/9876543210"] });
  assert.deepEqual([zoom.kind, zoom.kind_source], ["interview", "rule_confirmed"]);
  const phrase = classifyMail({ sender: "talent@acme.com", subject: "Interview invitation - Backend Engineer", text_excerpt: "We would like to invite you to an interview. Please schedule your interview using the link below: https://calendly.com/acme/45min" });
  assert.equal(phrase.kind, "interview");
  const slot = classifyMail({ sender: "jobs@globex.com", subject: "Next steps", text_excerpt: "We would like to invite you to an interview with our team. Please select a time that works for you." });
  assert.deepEqual([slot.kind, slot.kind_source], ["interview", "rule_confirmed"]);
});

test("assessment: platform link or sender confirms; bare word does not", () => {
  const hr = classifyMail({ sender: "support@hackerrank.com", subject: "Acme invites you to complete a coding assessment", text_excerpt: "Start your test: https://www.hackerrank.com/test/9af3/login" });
  assert.deepEqual([hr.category, hr.kind, hr.kind_source], ["important", "assessment", "rule_confirmed"]);
  const bare = classifyMail({ sender: "talent@acme.com", subject: "Your application", text_excerpt: "There will be an assessment after the first screen." });
  assert.equal(bare.kind, null);
  assert.equal(bare.category, "important", "a weak mention is kept but names no kind");
  const noLink = classifyMail({ sender: "noreply@myworkday.com", subject: "Complete your online assessment", text_excerpt: "Please complete the online assessment within 3 days." });
  assert.equal(noLink.kind, null, "an ATS no-reply mail with no link is not confirmed");
  assert.equal(noLink.kind_source, "rule_weak");
});

test("offer: needs offer wording and no marketing patterns", () => {
  const ok = classifyMail({ sender: "hr@acme.com", is_human: true, subject: "Your offer letter from Acme", text_excerpt: "We are pleased to offer you the role of SDE 2. Offer letter attached." });
  assert.deepEqual([ok.kind, ok.kind_source], ["offer", "rule_confirmed"]);
  const promo = classifyMail({ sender: "deals@jobsite.com", subject: "Job offer: 50% off premium resume service", text_excerpt: "Special offer! Unsubscribe any time." });
  assert.notEqual(promo.kind, "offer");
});

test("unconfirmed interview candidate falls back (human -> recruiter, ATS -> received)", () => {
  const human = classifyMail({ sender: "jane@acme.com", is_human: true, subject: "Quick chat", text_excerpt: "Do you have time for a phone screen sometime?" });
  assert.deepEqual([human.category, human.kind, human.kind_source], ["important", "recruiter", "rule_weak"]);
  const ats = classifyMail({ sender: "no-reply@lever.co", subject: "Update on your application", text_excerpt: "We will schedule a call with you soon." });
  assert.deepEqual([ats.category, ats.kind], ["received", null]);
  assert.equal(confirmKind("interview", { all: "x", sender: "", hasIcs: false, isReceived: false, isHuman: false }), false);
});

test("reverifyMail: dry run prints the diff and writes nothing; apply fixes tags and drops the interview row", async () => {
  const mailDb = createFakeDb({
    aa_mail_events: [
      { id: 1, user_id: "u1", sender: BLACKSTONE.sender, from_name: "Blackstone Careers", subject: BLACKSTONE.subject, text_excerpt: BLACKSTONE.text_excerpt, links: [], codes: [], is_human: false, category: "important", kind: "interview", company: "Blackstone", expires_at: null, received_at: "2026-11-01T00:00:00Z", has_attachments: false },
      { id: 2, user_id: "u1", sender: "talent@acme.com", from_name: "Acme", subject: "Interview invitation", text_excerpt: "Please schedule your interview: https://calendly.com/acme/45", links: [], codes: [], is_human: false, category: "important", kind: "interview", company: "Acme", expires_at: null, received_at: "2026-11-02T00:00:00Z", has_attachments: false },
    ],
    aa_interviews: [{ id: 10, mail_event_id: 1, user_id: "u1" }],
  });
  const dry = await reverifyMail({ mailDb });
  assert.equal(dry.stats.changed, 1);
  assert.deepEqual(dry.changes.map((c) => [c.id, c.from, c.to]), [[1, "important/interview", "received/-"]]);
  assert.equal(mailDb.rows("aa_mail_events")[0].kind, "interview");
  assert.equal(mailDb.rows("aa_interviews").length, 1);

  const done = await reverifyMail({ mailDb, apply: true });
  assert.equal(done.stats.interviews_removed, 1);
  const [a, b] = mailDb.rows("aa_mail_events");
  assert.deepEqual([a.category, a.kind, a.kind_source], ["received", null, null]);
  assert.ok(a.expires_at, "received mail gets a 30 day expiry");
  assert.deepEqual([b.kind, b.kind_source], ["interview", "rule_confirmed"]);
  assert.equal(mailDb.rows("aa_interviews").length, 0);
});

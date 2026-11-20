/**
 * Regression tests from the AutoApply bug sweep (2026-11-21): pricing agreement, backfill never turning kept mail
 * into expiring mail, invalid calendar dates in interview extraction, company filter with punctuation.
 * Pure / in-memory. Run: node --test test/autoapply-sweep.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TIERS, AUTO_APPLY, priceInrPaise, priceUsdCents } from "../config/tiers.js";
import { validateOrderInput } from "../lib/autoapply/orders.js";
import { backfillMail, cleanupExpiredMail } from "../lib/autoapply/mailJobs.js";
import { findDateTime, parseIcs, extractInterview, isRealDate } from "../lib/autoapply/interview.js";
import { companyTerm } from "../routes/autoapply.js";
import { createFakeDb } from "./fixtures/fakeSupabase.mjs";

test("pricing: plans, packs and the order amount all come from the one config", () => {
  assert.deepEqual([priceInrPaise("free", "monthly"), priceInrPaise("pro", "monthly"), priceInrPaise("max", "monthly")], [0, 19900, 59900]);
  assert.deepEqual([priceInrPaise("pro", "yearly"), priceInrPaise("max", "yearly")], [199000, 599000]);
  assert.deepEqual([priceUsdCents("pro", "monthly"), priceUsdCents("max", "monthly")], [499, 899]);
  assert.deepEqual([priceUsdCents("pro", "yearly"), priceUsdCents("max", "yearly")], [4990, 8990]);
  assert.equal(TIERS.free.price.monthly, 0);
  assert.deepEqual(AUTO_APPLY.packs, { service: { 50: 59900, 100: 115000 }, product: { 50: 89900, 100: 149900 } });
  // the client cannot pick the amount: a price in the body is ignored
  const o = validateOrderInput({ pack_kind: "product", pack_size: "100", price_paise: 100, amount: 100 });
  assert.equal(o.price_paise, 149900);
  assert.throws(() => validateOrderInput({ pack_kind: "service", pack_size: 80 }), /50 or 100/);
});

test("backfill: a row already classified on arrival (kind set) keeps its category, so it never starts expiring", async () => {
  const base = { user_id: "u-1", alias: "one.aaaa", codes: [], links: [], is_human: false, received_at: "2026-09-01T00:00:00.000Z" };
  const mailDb = createFakeDb({
    aa_mail_events: [
      // an .ics interview invite: 'important' + 'interview' on arrival because of the invite, which is not stored.
      // Its text alone reads like a receipt.
      { ...base, id: 1, sender: "no-reply@globex.com", subject: "Invitation: Chat with Priya @ Tue 24 Nov 3pm", text_excerpt: "Thank you for applying to Globex.", category: "important", kind: "interview", company: "Globex", expires_at: null },
      // an old row (no kind yet) is still re-classified: a hidden rejection becomes 'rejected'
      { ...base, id: 2, sender: "no-reply@acme.com", subject: "Your application", text_excerpt: "We regret to inform you that we will not be moving forward with your application.", category: "important", expires_at: null },
      // a receipt whose expiry Postgres returns as '+00:00' is not rewritten on every run
      { ...base, id: 3, sender: "no-reply@acme.com", subject: "Application received", text_excerpt: "We have received your application.", category: "received", company: "Acme", expires_at: "2026-10-01T00:00:00+00:00" },
    ],
    aa_interviews: [{ id: 9, mail_event_id: 1, user_id: "u-1", company: "Globex" }],
  });
  const s = await backfillMail({ mailDb });
  const by = (id) => mailDb.rows("aa_mail_events").find((r) => r.id === id);
  assert.equal(by(1).category, "important");
  assert.equal(by(1).kind, "interview");
  assert.equal(by(1).expires_at, null, "an interview invite is never scheduled for deletion");
  assert.equal(by(2).category, "rejected");
  assert.equal(by(3).expires_at, "2026-10-01T00:00:00+00:00");
  assert.equal(s.updated, 1, "only the re-classified rejection is written");

  const r = await cleanupExpiredMail({ mailDb, now: new Date("2026-11-21T00:00:00Z") });
  assert.deepEqual(r, { deleted: 2 });
  assert.ok(by(1), "the interview mail survives the cleanup");
  assert.equal(mailDb.rows("aa_interviews").length, 1);
});

test("interview dates: impossible calendar dates are not rolled into the next month", () => {
  assert.equal(isRealDate(2026, 11, 30), true);
  assert.equal(isRealDate(2026, 11, 31), false);
  assert.equal(isRealDate(2026, 2, 29), false);
  assert.equal(isRealDate(2028, 2, 29), true);
  assert.equal(findDateTime("Your interview is on 31 Nov 2026 at 3 PM IST."), null);
  assert.equal(findDateTime("Interview: 30/02/2026 at 11:00 AM"), null);
  // a real date later in the text is still found
  const ok = findDateTime("Not 31 Nov 2026 at 3 PM; the interview is on 1 Dec 2026 at 3 PM IST.");
  assert.equal(ok.starts_at, "2026-12-01T09:30:00.000Z");

  const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "DTSTART:20261131T100000Z", "DTEND:20261131T110000Z", "SUMMARY:Interview", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  assert.equal(parseIcs(ics).start, null);
  const iv = extractInterview({ subject: "Interview invite", text_excerpt: "See the invite.", ics, received_at: "2026-11-20T00:00:00Z" });
  assert.equal(iv.starts_at, null, "a broken invite date leaves the time unset instead of a wrong one");
  assert.equal(iv.source, "text");
});

test("inbox company filter: names with commas / parentheses still match themselves", async () => {
  assert.equal(companyTerm("Acme, Inc."), "Acme, Inc.");
  assert.equal(companyTerm("Tata Consultancy Services (TCS)"), "Tata Consultancy Services (TCS)");
  assert.equal(companyTerm("50%_off*\\"), "50__off__");
  const db = createFakeDb({ aa_mail_events: [{ id: 1, user_id: "u", company: "Acme, Inc." }, { id: 2, user_id: "u", company: "Acme Labs" }] });
  const { data } = await db.from("aa_mail_events").select("id").ilike("company", `%${companyTerm("Acme, Inc.")}%`);
  assert.deepEqual(data.map((r) => r.id), [1]);
});

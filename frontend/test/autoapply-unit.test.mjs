/**
 * AutoApply unit tests (no network, no Supabase/Razorpay/Resend).
 * Run: npm run test:autoapply
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { encryptSecret, decryptSecret } from "../lib/autoapply/vault.js";
import { validateAnswer, learnedKey, normaliseLabel, publicQuestions, isValidKey } from "../lib/autoapply/questions.js";
import { verifyInbound, signInbound, parseAlias } from "../lib/autoapply/inbound.js";
import { refundAmount } from "../lib/autoapply/refunds.js";
import { istMonthStart, istDayStart, packPrice } from "../lib/autoapply/limits.js";
import { draftFromText, extractText } from "../lib/autoapply/resumeParse.js";
import { matchesPrefs, slugFirstName } from "../routes/autoapply.js";
import { AUTO_APPLY } from "../config/tiers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("vault: round trip, AAD binding, tamper detection", () => {
  const key = crypto.randomBytes(32);
  const blob = encryptSecret("hunter2", "u1", "a.example.com", { key });
  assert.equal(decryptSecret(blob, "u1", "a.example.com", { key }), "hunter2");
  assert.throws(() => decryptSecret(blob, "u2", "a.example.com", { key }), /decrypt failed/);
  assert.throws(() => decryptSecret(blob, "u1", "b.example.com", { key }), /decrypt failed/);
  const raw = Buffer.from(blob, "base64");
  raw[14] ^= 1;
  assert.throws(() => decryptSecret(raw.toString("base64"), "u1", "a.example.com", { key }), /decrypt failed/);
  assert.equal(raw.length, 12 + Buffer.byteLength("hunter2") + 16);
});

test("vault: fixture vector (cross-checked with Python AESGCM)", () => {
  const v = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "aa_vault_vector.json"), "utf8"));
  assert.equal(decryptSecret(v.secret_ciphertext, v.user_id, v.tenant_host, { key: v.key_b64 }), v.plaintext);
  const again = encryptSecret(v.plaintext, v.user_id, v.tenant_host, { key: v.key_b64, nonce: Buffer.from(v.nonce_hex, "hex") });
  assert.equal(again, v.secret_ciphertext);
});

const PY_VECTOR = "C:\\Repos\\AutoJobApplier\\cloud_hunter\\saas\\tests\\vault_vector.json";
test("vault: Python-written vector (if present)", { skip: !existsSync(PY_VECTOR) && "python vector not written yet" }, () => {
  const v = JSON.parse(readFileSync(PY_VECTOR, "utf8"));
  const key = v.key_b64 || v.key;
  const blob = v.secret_ciphertext || v.ciphertext_b64 || v.ciphertext;
  assert.equal(decryptSecret(blob, v.user_id, v.tenant_host, { key }), v.plaintext);
});

test("questions: list shape and validation", () => {
  const qs = publicQuestions();
  assert.ok(qs.find((q) => q.key === "fields.first_name"));
  assert.ok(qs.every((q) => q.key && q.label && ["text", "number", "select", "multiselect", "yesno", "date"].includes(q.type)));
  assert.ok(qs.every((q) => q.type === "text" || q.type === "date" || q.type === "number" || (Array.isArray(q.options) && q.options.length > 1)));
  assert.ok(qs.every((q) => !("free" in q)));
  assert.deepEqual(validateAnswer("facts.notice_period_days", "30"), { ok: true, value: "30" });
  assert.equal(validateAnswer("facts.notice_period_days", "soon").ok, false);
  assert.deepEqual(validateAnswer("facts.needs_sponsorship", "No"), { ok: true, value: "no" });
  assert.equal(validateAnswer("facts.needs_sponsorship", "maybe").ok, false);
  assert.equal(validateAnswer("facts.gender", "prefer to self-describe").ok, false); // dropdown only now
  assert.deepEqual(validateAnswer("facts.gender", "Prefer not to say"), { ok: true, value: "decline" }); // label -> value
  assert.deepEqual(validateAnswer("facts.work_authorized_in", "in, us"), { ok: true, value: "IN,US" });
  assert.equal(validateAnswer("facts.date_of_birth", "1999-13-40").ok, false);
  assert.deepEqual(validateAnswer("fields.city", ""), { ok: true, value: null });
  assert.equal(validateAnswer("fields.nope", "x").ok, false);
});

test("questions: learned key = q.<sha1(normalised label)[:16]>", () => {
  assert.equal(normaliseLabel("  Are you willing to WORK from office?  "), "are you willing to work from office");
  const k = learnedKey("Are you willing to work from office?");
  const expect = "q." + crypto.createHash("sha1").update("are you willing to work from office").digest("hex").slice(0, 16);
  assert.equal(k, expect);
  assert.ok(isValidKey(k));
  assert.equal(learnedKey("Are you willing to work from office"), k);
});

test("inbound: HMAC verify, 60s window, timing-safe mismatch", () => {
  const secret = "s3cr3t";
  const body = Buffer.from(JSON.stringify({ to: "a.b@x" }));
  const ts = 1_800_000_000;
  const sig = signInbound(secret, String(ts), body);
  assert.deepEqual(verifyInbound({ secret, timestamp: String(ts), signature: sig, rawBody: body, nowS: ts + 59 }), { ok: true });
  assert.equal(verifyInbound({ secret, timestamp: String(ts), signature: sig, rawBody: body, nowS: ts + 61 }).code, "stale_timestamp");
  assert.equal(verifyInbound({ secret, timestamp: String(ts), signature: sig.replace(/^./, sig[0] === "a" ? "b" : "a"), rawBody: body, nowS: ts }).code, "bad_signature");
  assert.equal(verifyInbound({ secret, timestamp: String(ts), signature: "zz", rawBody: body, nowS: ts }).code, "bad_signature");
  assert.equal(verifyInbound({ secret: "", timestamp: String(ts), signature: sig, rawBody: body, nowS: ts }).code, "inbound_unconfigured");
  assert.equal(verifyInbound({ secret, timestamp: String(ts), signature: sig, rawBody: Buffer.from("tampered"), nowS: ts }).code, "bad_signature");
});

test("inbound: alias parsing", () => {
  assert.deepEqual(parseAlias("debopriyo.k7q2.acme@apply.vloombox.in"), { local: "debopriyo.k7q2.acme", alias: "debopriyo.k7q2", tag: "acme" });
  assert.deepEqual(parseAlias("Deb <Deb.K7Q2@apply.vloombox.in>"), { local: "deb.k7q2", alias: "deb.k7q2", tag: null });
});

test("refunds: amount = floor(price * remaining / total)", () => {
  assert.deepEqual(refundAmount({ price_paise: 59900, credits_total: 50, credits_used: 20 }), { remaining: 30, paise: 35940 });
  assert.deepEqual(refundAmount({ price_paise: 79900, credits_total: 80, credits_used: 0 }), { remaining: 80, paise: 79900 });
  assert.deepEqual(refundAmount({ price_paise: 99900, credits_total: 100, credits_used: 100 }), { remaining: 0, paise: 0 });
  assert.deepEqual(refundAmount({ price_paise: 99900, credits_total: 100, credits_used: 33 }), { remaining: 67, paise: 66933 });
});

test("limits: IST month/day boundaries", () => {
  // 2026-11-30 20:00 UTC = 2026-12-01 01:30 IST -> December
  const d = new Date("2026-11-30T20:00:00Z");
  assert.equal(istMonthStart(d).toISOString(), "2026-11-30T18:30:00.000Z");
  assert.equal(istDayStart(d).toISOString(), "2026-11-30T18:30:00.000Z");
  assert.equal(istMonthStart(new Date("2026-11-16T10:00:00Z")).toISOString(), "2026-10-31T18:30:00.000Z");
  assert.equal(packPrice("service", 100), 115000);
  assert.equal(packPrice("product", 100), 149900);
  assert.equal(packPrice("service", 80), null); // 80 packs removed
  assert.equal(packPrice("product", 55), null);
  assert.deepEqual(AUTO_APPLY.plans, ["pro", "max"]);
});

test("resume: rule-based draft", () => {
  const text = `PRIYA SHARMA
Bengaluru, Karnataka
priya.sharma@example.com | +91 98765 43210 | linkedin.com/in/priyasharma | github.com/priyas
Summary
Backend engineer with 5+ years of experience building payments systems.
Experience
Senior Software Engineer at Acme Payments
2021 - Present
- Built things
Software Engineer, Foo Corp
2019 - 2021
Education
B.Tech in Computer Science, National Institute of Technology Trichy, 2019
Skills
Languages: Go, Java, Python
Tools: Kafka, Postgres | Kubernetes`;
  const d = draftFromText(text, new Date("2026-11-16T00:00:00Z"));
  assert.equal(d.first_name, "Priya");
  assert.equal(d.last_name, "Sharma");
  assert.equal(d.email, "priya.sharma@example.com");
  assert.match(d.phone, /98765/);
  assert.equal(d.linkedin, "https://linkedin.com/in/priyasharma");
  assert.equal(d.github, "https://github.com/priyas");
  assert.equal(d.total_experience_years, 5);
  assert.equal(d.current_title, "Senior Software Engineer");
  assert.equal(d.current_company, "Acme Payments");
  for (const s of ["Go", "Java", "Python", "Kafka", "Postgres", "Kubernetes"]) assert.ok(d.skills.includes(s), s);
  assert.equal(d.suggested_answers["fields.first_name"], "Priya");
  assert.equal(d.suggested_answers["facts.graduation_year"], "2019");
  assert.match(d.suggested_answers["fields.degree"], /B\.Tech/i);
});

test("resume: docx text extraction (jszip)", async () => {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("word/document.xml", '<w:document><w:body><w:p><w:r><w:t>Ravi Kumar</w:t></w:r></w:p><w:p><w:r><w:t>ravi@example.com &amp; more</w:t></w:r></w:p></w:body></w:document>');
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const text = await extractText(buf, "docx");
  assert.match(text, /Ravi Kumar\nravi@example.com & more/);
});

test("supply: prefs matching + alias slug", () => {
  const job = { title: "Senior Backend Engineer", location: "Bengaluru, Karnataka, India", company: "Acme" };
  assert.ok(matchesPrefs(job, {}));
  assert.ok(matchesPrefs(job, { titles: ["backend engineer"], locations: ["bengaluru"] }));
  assert.ok(matchesPrefs(job, { titles: ["engineer backend"] }));
  assert.ok(!matchesPrefs(job, { titles: ["data scientist"] }));
  assert.ok(!matchesPrefs(job, { locations: ["pune"] }));
  assert.ok(!matchesPrefs(job, { blocked_companies: ["acme"] }));
  assert.ok(matchesPrefs({ ...job, location: "Remote - India" }, { locations: ["remote"] }));
  assert.equal(slugFirstName("Débopriyo!"), "debopriyo");
  assert.equal(slugFirstName("  "), "user");
});

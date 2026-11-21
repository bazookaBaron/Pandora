import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PostalMime from 'postal-mime';
import {
  buildPayload, extractCodes, extractLinks, decideIsHuman, htmlToText, isNoiseNumber, rawKeyFor, isoSeconds,
  CODE_RE, VERIFY_HINT,
} from '../src/extract.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function load(name, to = 'amar.p3x9@apply.vloombox.in') {
  const raw = fs.readFileSync(path.join(here, 'fixtures', name), 'utf8').replace(/\r?\n/g, '\r\n');
  const parsed = await PostalMime.parse(raw);
  return buildPayload(parsed, { envelopeTo: to, receivedAt: new Date('2026-11-16T10:00:00.123Z'), rawKey: 'mail/2026/11/16/x.eml' });
}

test('Workday account verification link (quoted-printable, plain + HTML)', async () => {
  const p = await load('workday_verify_link.eml', 'Debopriyo.K7Q2.Acme@apply.vloombox.in');
  assert.equal(p.links[0], 'https://acme.wd3.myworkdayjobs.com/en-US/External/activate/9f8e7d6c-5b4a-4321-a0b1-c2d3e4f5a6b7?redirect=%2Fen-US%2FExternal%2Fjob%2FBangalore%2FSenior-Engineer_R-104233');
  assert.ok(!p.links.some((l) => /logo|privacy|\.png/.test(l)), 'logo / privacy links skipped');
  assert.deepEqual(p.codes, [], 'no codes from zip, phone, year, CSS, requisition');
  assert.equal(p.is_human, false);
  assert.equal(p.to, 'debopriyo.k7q2.acme@apply.vloombox.in');
  assert.equal(p.from, 'acme@myworkday.com');
  assert.equal(p.from_name, 'Acme Careers');
  assert.equal(p.message_id, '<wd-20261116100000-91ab@myworkday.com>');
  assert.equal(p.received_at, '2026-11-16T10:00:00Z');
});

test('Workday 6-digit code in HTML only, CSS with "code" ignored', async () => {
  const p = await load('workday_code.eml');
  assert.deepEqual(p.codes, ['482913']);
  assert.equal(p.is_human, false);
  assert.match(p.text_excerpt, /482913/);
});

test('Oracle one-time passcode on its own line', async () => {
  const p = await load('oracle_code.eml');
  assert.deepEqual(p.codes, ['731945']);
  assert.equal(p.is_human, false);
});

test('Greenhouse 8-char alphanumeric security code', async () => {
  const p = await load('greenhouse_code.eml');
  assert.deepEqual(p.codes, ['X7kP2mQa']);
  assert.equal(p.is_human, false);
});

test('SuccessFactors verification link: token link first, unsubscribe dropped', async () => {
  const p = await load('successfactors_link.eml');
  assert.match(p.links[0], /career_ns=registration_complete&token=AbC123xYz789/);
  assert.ok(!p.links.some((l) => /unsubscribe/.test(l)));
  assert.deepEqual(p.codes, []);
  assert.equal(p.is_human, false);
});

test('iCIMS code: street number and job number after it are not codes', async () => {
  const p = await load('icims_code.eml');
  assert.deepEqual(p.codes, ['905127']);
  assert.equal(p.is_human, false);
});

test('recruiter personal reply is human, phone and time are not codes', async () => {
  const p = await load('recruiter_reply.eml');
  assert.equal(p.is_human, true);
  assert.deepEqual(p.codes, []);
  assert.deepEqual(p.links, []);
  assert.equal(p.reply_to, 'priya.sharma@acme.com');
  assert.equal(p.from_name, 'Priya Sharma');
});

test('newsletter with prices, phones, dates, promo code yields no codes', async () => {
  const p = await load('newsletter.eml');
  assert.deepEqual(p.codes, []);
  assert.equal(p.is_human, false);
  assert.ok(!p.links.some((l) => /unsubscribe|open\.gif/.test(l)));
});

test('payload has exactly the contract keys', async () => {
  const p = await load('workday_code.eml');
  assert.deepEqual(Object.keys(p).sort(), ['auth', 'codes', 'from', 'from_name', 'has_attachments', 'ics', 'is_human', 'links', 'meeting_links', 'message_id', 'raw_key',
    'received_at', 'reply_to', 'subject', 'text_excerpt', 'to']);
  assert.ok(p.text_excerpt.length <= 2000);
  assert.equal(p.ics, null);
  assert.deepEqual(p.meeting_links, []);
});

test('interview invite: .ics text and meeting links reach the payload; the invite is not an attachment', async () => {
  const ics = [
    'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    'DTSTART;TZID=India Standard Time:20261124T103000', 'DTEND;TZID=India Standard Time:20261124T113000',
    'SUMMARY:Interview: Backend Engineer', 'LOCATION:Microsoft Teams Meeting',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const raw = [
    'From: Jane Recruiter <jane@acme.com>', 'To: amar.p3x9@apply.vloombox.in', 'Subject: Invitation: Interview with Acme',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b1"', '',
    '--b1', 'Content-Type: multipart/alternative; boundary="b2"', '',
    '--b2', 'Content-Type: text/plain; charset=utf-8', '',
    'Join the call: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x',
    'Or Zoom backup https://acme.zoom.us/j/99887766554?pwd=xyz. Thanks',
    '--b2', 'Content-Type: text/calendar; charset=utf-8; method=REQUEST', '', ics, '--b2--',
    '--b1', 'Content-Type: application/ics; name="invite.ics"', 'Content-Disposition: attachment; filename="invite.ics"', '', ics, '--b1--', '',
  ].join('\r\n');
  const parsed = await PostalMime.parse(raw);
  const p = buildPayload(parsed, { envelopeTo: 'amar.p3x9@apply.vloombox.in', receivedAt: new Date('2026-11-20T06:00:00Z') });
  assert.match(p.ics, /BEGIN:VEVENT[\s\S]*DTSTART;TZID=India Standard Time:20261124T103000/);
  assert.equal(p.has_attachments, false, 'a calendar invite is not an attachment the user has to ask for');
  assert.deepEqual(p.meeting_links, ['https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x', 'https://acme.zoom.us/j/99887766554?pwd=xyz']);
  assert.ok(!p.links.some((l) => /zoom|teams/.test(l)), 'meeting links stay out of the verification links');
});

test('regexes are the mail_otp.py ones', () => {
  assert.equal(CODE_RE.source, String.raw`(?<![\d#])(\d{4,8})(?!\d)`);
  assert.ok(VERIFY_HINT.test('Sign-in') && VERIFY_HINT.test('one time') && !VERIFY_HINT.test('weekly digest'));
});

test('plain-text code variants', () => {
  const t = (subject, text) => extractCodes({ subject, text });
  assert.deepEqual(t('Your code', 'Your verification code is: 4829'), ['4829']);
  assert.deepEqual(t('Sign in', '123456 is your one-time sign-in code.'), ['123456']);
  assert.deepEqual(t('Verify', 'Your code: AB12CD34'), ['AB12CD34']);
  assert.deepEqual(t('Verify', 'Security code: KQWZTRMB'), ['KQWZTRMB']);
  assert.deepEqual(t('Hello', 'Thanks for your interest. Call 9845012345.'), []);
  assert.deepEqual(t('Order shipped', 'Order #482913 total $1299.00'), [], 'no VERIFY_HINT and noise anyway');
  assert.deepEqual(t('Your code', 'Order #482913'), [], '# before a number is never a code');
  assert.deepEqual(t('Verify your email', 'Use code SAVE20 at checkout. Pin code 560001.'), []);
});

test('isNoiseNumber basics', () => {
  const n = (s, num) => { const i = s.indexOf(num); return isNoiseNumber(s, i, i + num.length); };
  assert.ok(n('price $1299 now', '1299'));
  assert.ok(n('call 415-555-0134', '0134'));
  assert.ok(n('on 16/11/2026', '2026'));
  assert.ok(n('Job ID: 12345', '12345'));
  assert.ok(n('Join 25000 engineers', '25000'));
  assert.ok(!n('your code is 482913.', '482913'));
});

test('htmlToText strips style/script/head and decodes entities', () => {
  const t = htmlToText('<head><title>x 9999</title></head><style>.code{width:1234px}</style><p>A&amp;B&nbsp;&#8377;5</p><td>123456</td>');
  assert.ok(!/9999|1234px/.test(t));
  assert.match(t, /A&B ₹5/);
  assert.match(t, /^123456$/m);
});

test('links: mailto, images, tracking pixels skipped; &amp; decoded; trailing punctuation trimmed', () => {
  const links = extractLinks({
    subject: 'Verify',
    text: 'Go (https://x.myworkdayjobs.com/en-US/c/activate/abc?a=1&amp;b=2). mailto:a@b.c https://t.example/open.gif?u=1 https://cdn.example/a.png',
  });
  assert.deepEqual(links, ['https://x.myworkdayjobs.com/en-US/c/activate/abc?a=1&b=2']);
});

test('is_human signals', () => {
  const base = { fromAddr: 'jane.doe@acme.com', headers: {}, subject: 'Quick chat?', text: 'Hi, are you free tomorrow?' };
  assert.equal(decideIsHuman(base), true);
  assert.equal(decideIsHuman({ ...base, fromAddr: 'noreply@acme.com' }), false);
  assert.equal(decideIsHuman({ ...base, fromAddr: 'careers@acme.com' }), false);
  assert.equal(decideIsHuman({ ...base, fromAddr: 'acme@myworkday.com' }), false);
  assert.equal(decideIsHuman({ ...base, fromAddr: 'jane.doe@hire.lever.co' }), true, 'recruiter via ATS relay');
  assert.equal(decideIsHuman({ ...base, headers: { 'list-unsubscribe': '<x>' } }), false);
  assert.equal(decideIsHuman({ ...base, headers: { 'auto-submitted': 'auto-replied' } }), false);
  assert.equal(decideIsHuman({ ...base, headers: { 'auto-submitted': 'no' } }), true);
  assert.equal(decideIsHuman({ ...base, headers: { precedence: 'bulk' } }), false);
  assert.equal(decideIsHuman({ ...base, codes: ['123456'] }), false);
  assert.equal(decideIsHuman({ ...base, text: 'This is an automated message, please do not reply.' }), false);
  assert.equal(decideIsHuman({ ...base, text: 'We have received your application for SWE.' }), false);
  assert.equal(decideIsHuman({ ...base, fromAddr: '' }), false);
});

test('raw key and timestamp format', () => {
  const d = new Date('2026-01-05T23:59:59.999Z');
  assert.equal(rawKeyFor(d, 'u-1'), 'mail/2026/01/05/u-1.eml');
  assert.equal(isoSeconds(d), '2026-01-05T23:59:59Z');
});

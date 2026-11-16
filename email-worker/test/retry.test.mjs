import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker, { deliverOrPark, retryPending, isPoison, DURABLE, RETRY } from '../src/index.js';
import { hasRealAttachments } from '../src/extract.js';

RETRY.baseMs = 1;

/** Minimal in-memory D1 covering the 4 statements the worker uses. */
function fakeD1() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      return {
        bind(...a) {
          return {
            async run() {
              if (/^INSERT/.test(sql)) rows.set(a[0], { id: a[0], payload: a[1], created_at: a[2], next_attempt_at: a[3], attempts: 0, last_error: a[4] });
              else if (/^DELETE/.test(sql)) rows.delete(a[0]);
              else if (/^UPDATE/.test(sql)) Object.assign(rows.get(a[0]), { attempts: rows.get(a[0]).attempts + 1, next_attempt_at: a[1], last_error: a[2] });
              return { success: true };
            },
            async all() {
              const results = [...rows.values()].filter((r) => r.next_attempt_at <= a[0]).sort((x, y) => x.created_at - y.created_at).slice(0, a[1]);
              return { results };
            },
          };
        },
      };
    },
  };
}

const payload = { to: 'a.b@apply.vloombox.in', from: 'x@y.com', subject: 'hi', raw_key: null, codes: [], links: [], has_attachments: false };
const quiet = (t) => { const e = console.error; console.error = () => {}; t.after(() => { console.error = e; }); };
const st = (code) => async () => new Response('', { status: code });

function fakeMessage(raw, { to = 'amar.p3x9.globex@apply.vloombox.in', from = 'bounce@acme.com' } = {}) {
  const bytes = new TextEncoder().encode(raw);
  return { to, from, rawSize: bytes.byteLength, headers: new Headers(), raw: new Blob([bytes]).stream(), rejected: null, setReject(r) { this.rejected = r; } };
}

test('deliverOrPark(): API down -> payload parked in D1; success path parks nothing', async (t) => {
  quiet(t);
  const AA_PENDING = fakeD1();
  const env = { AA_API_BASE: 'https://x', AA_INBOUND_SECRET: 's', AA_PENDING };
  const r = await deliverOrPark(env, payload, { fetchImpl: st(503), sleep: async () => {}, now: () => 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.parked, true);
  assert.equal(AA_PENDING.rows.size, 1);
  const row = [...AA_PENDING.rows.values()][0];
  assert.deepEqual(JSON.parse(row.payload), payload);
  assert.equal(row.created_at, 1000);

  const ok = await deliverOrPark(env, payload, { fetchImpl: async () => new Response('{}'), sleep: async () => {} });
  assert.equal(ok.ok, true);
  assert.equal(AA_PENDING.rows.size, 1);
});

test('deliverOrPark(): 401 is parked (config fixable); a 400 is dropped; no binding just logs', async (t) => {
  quiet(t);
  const AA_PENDING = fakeD1();
  const env = { AA_API_BASE: 'https://x', AA_INBOUND_SECRET: 's', AA_PENDING };
  assert.equal((await deliverOrPark(env, payload, { fetchImpl: st(401), sleep: async () => {} })).parked, true);
  assert.equal((await deliverOrPark(env, payload, { fetchImpl: st(400), sleep: async () => {} })).dropped, true);
  assert.equal(AA_PENDING.rows.size, 1);
  const none = await deliverOrPark({ AA_API_BASE: 'https://x', AA_INBOUND_SECRET: 's' }, payload, { fetchImpl: st(503), sleep: async () => {} });
  assert.equal(none.parked, false);
  assert.ok(isPoison(422) && !isPoison(401) && !isPoison(503) && !isPoison(null));
});

test('retryPending(): re-delivers with a fresh HMAC and deletes on success', async () => {
  const AA_PENDING = fakeD1();
  const env = { AA_API_BASE: 'https://api.test', AA_INBOUND_SECRET: 'secret', AA_PENDING };
  const t0 = 1_000_000_000_000;
  AA_PENDING.rows.set('p1', { id: 'p1', payload: JSON.stringify(payload), created_at: t0, next_attempt_at: t0 + 300000, attempts: 0, last_error: 'HTTP 503' });
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return new Response('{}'); };

  assert.deepEqual(await retryPending(env, { fetchImpl, now: () => t0 + 1000 }), { delivered: 0, failed: 0, gave_up: 0, dropped: 0 });
  assert.equal(seen.length, 0, 'not due yet');

  const nowMs = t0 + 301000;
  const realNow = Date.now;
  Date.now = () => nowMs;   // sign() timestamps come from Date.now()
  try {
    const r = await retryPending(env, { fetchImpl, now: () => nowMs });
    assert.equal(r.delivered, 1);
  } finally { Date.now = realNow; }
  assert.equal(AA_PENDING.rows.size, 0);
  assert.equal(seen.length, 1);
  const { url, init } = seen[0];
  assert.equal(url, 'https://api.test/api/inbound/email');
  assert.equal(init.headers['X-AA-Timestamp'], String(Math.floor(nowMs / 1000)));
  const expected = crypto.createHmac('sha256', 'secret').update(`${init.headers['X-AA-Timestamp']}.${init.body}`).digest('hex');
  assert.equal(init.headers['X-AA-Signature'], expected);
});

test('retryPending(): failure backs off; gives up after 3 days; 400 dropped', async (t) => {
  quiet(t);
  const AA_PENDING = fakeD1();
  const env = { AA_API_BASE: 'https://api.test', AA_INBOUND_SECRET: 'secret', AA_PENDING };
  const t0 = 1_000_000_000_000;
  AA_PENDING.rows.set('p1', { id: 'p1', payload: JSON.stringify(payload), created_at: t0, next_attempt_at: t0, attempts: 0, last_error: null });

  const r1 = await retryPending(env, { fetchImpl: st(503), now: () => t0 + 1000 });
  assert.equal(r1.failed, 1);
  const row = AA_PENDING.rows.get('p1');
  assert.equal(row.attempts, 1);
  assert.ok(row.next_attempt_at >= t0 + 1000 + 5 * 60 * 1000);
  assert.ok(row.next_attempt_at <= t0 + 1000 + DURABLE.backoffMaxMs);

  const late = t0 + DURABLE.giveUpMs + 10 * 60 * 1000;
  row.next_attempt_at = 0;
  const r2 = await retryPending(env, { fetchImpl: st(503), now: () => late });
  assert.equal(r2.gave_up, 1);
  assert.equal(AA_PENDING.rows.size, 0);

  AA_PENDING.rows.set('p2', { id: 'p2', payload: JSON.stringify(payload), created_at: late, next_attempt_at: late, attempts: 0, last_error: null });
  assert.equal((await retryPending(env, { fetchImpl: st(400), now: () => late })).dropped, 1);
  assert.equal((await retryPending({ AA_API_BASE: 'x' }, { fetchImpl: st(503) })).delivered, 0, 'no binding: no-op');
});

test('scheduled(): wired to retryPending', async () => {
  const AA_PENDING = fakeD1();
  AA_PENDING.rows.set('p1', { id: 'p1', payload: JSON.stringify(payload), created_at: Date.now() - 600000, next_attempt_at: 0, attempts: 0, last_error: null });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}');
  const waits = [];
  try {
    await worker.scheduled({}, { AA_API_BASE: 'https://api.test', AA_INBOUND_SECRET: 's', AA_PENDING }, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(AA_PENDING.rows.size, 0);
});

test('email(): API down at receive time parks the mail end to end', async (t) => {
  quiet(t);
  const AA_PENDING = fakeD1();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 503 });
  t.after(() => { globalThis.fetch = realFetch; });
  const pending = [];
  await worker.email(fakeMessage('From: a@b.com\r\nSubject: hi\r\n\r\nhello'), { AA_API_BASE: 'https://api.test', AA_INBOUND_SECRET: 's', AA_PENDING }, { waitUntil: (p) => pending.push(p) });
  const [res] = await Promise.all(pending);
  assert.equal(res.parked, true);
  assert.equal(AA_PENDING.rows.size, 1);
});

test('has_attachments: set for real attachments, not for inline logos', async (t) => {
  assert.equal(hasRealAttachments([]), false);
  assert.equal(hasRealAttachments(undefined), false);
  assert.equal(hasRealAttachments([{ disposition: 'inline', related: true }]), false);
  assert.equal(hasRealAttachments([{ disposition: 'attachment', filename: 'test.pdf' }]), true);
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_u, init) => { bodies.push(JSON.parse(init.body)); return new Response('{}'); };
  t.after(() => { globalThis.fetch = realFetch; });
  const mime = 'From: HR <hr@acme.com>\r\nSubject: Assessment\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nSee attached.\r\n--b\r\nContent-Type: application/pdf; name="t.pdf"\r\nContent-Disposition: attachment; filename="t.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n--b--\r\n';
  for (const raw of [mime, 'From: a@b.com\r\nSubject: hi\r\n\r\nhello']) {
    const pending = [];
    await worker.email(fakeMessage(raw), { AA_API_BASE: 'https://api.test', AA_INBOUND_SECRET: 's' }, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  }
  assert.equal(bodies[0].has_attachments, true);
  assert.equal(bodies[1].has_attachments, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { sign, deliver, RETRY } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(fs.readFileSync(path.join(here, 'vectors', 'hmac_vector.json'), 'utf8'));
RETRY.baseMs = 1;

test('HMAC vector: WebCrypto sign == node:crypto == stored expected', async () => {
  const web = await sign(vector.secret, vector.ts, vector.body);
  const node = crypto.createHmac('sha256', vector.secret).update(`${vector.ts}.${vector.body}`, 'utf8').digest('hex');
  assert.equal(web, vector.expected_signature);
  assert.equal(node, vector.expected_signature);
  assert.match(web, /^[0-9a-f]{64}$/);
});

function fakeMessage(raw, { to = 'amar.p3x9.globex@apply.vloombox.in', from = 'bounce@myworkday.com', rawSize } = {}) {
  const bytes = new TextEncoder().encode(raw);
  return {
    to, from, rawSize: rawSize ?? bytes.byteLength,
    headers: new Headers(),
    raw: new Blob([bytes]).stream(),
    rejected: null,
    setReject(reason) { this.rejected = reason; },
  };
}

function fakeEnv() {
  const store = new Map();
  return {
    store,
    env: {
      AA_API_BASE: 'https://api.example.test/',
      AA_INBOUND_SECRET: 'test-secret',
      AA_MAIL: { async put(key, value, opts) { store.set(key, { value, opts }); } },
    },
  };
}

test('email(): stores raw in R2, POSTs signed contract body, retries on 503', async (t) => {
  const raw = fs.readFileSync(path.join(here, 'fixtures', 'workday_code.eml'), 'utf8').replace(/\r?\n/g, '\r\n');
  const { env, store } = fakeEnv();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response('{}', { status: calls.length === 1 ? 503 : 200 });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const pending = [];
  const msg = fakeMessage(raw);
  await worker.email(msg, env, { waitUntil: (p) => pending.push(p) });
  const results = await Promise.all(pending);

  assert.equal(msg.rejected, null);
  assert.equal(store.size, 1);
  const [key, obj] = [...store.entries()][0];
  assert.match(key, /^mail\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.eml$/);
  assert.equal(obj.opts.httpMetadata.contentType, 'message/rfc822');
  assert.equal(new TextDecoder().decode(obj.value), raw);

  assert.equal(calls.length, 2);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].attempts, 2);
  const { url, init } = calls[1];
  assert.equal(url, 'https://api.example.test/api/inbound/email');
  const ts = init.headers['X-AA-Timestamp'];
  assert.match(ts, /^\d{10}$/);
  const expected = crypto.createHmac('sha256', 'test-secret').update(`${ts}.${init.body}`).digest('hex');
  assert.equal(init.headers['X-AA-Signature'], expected);
  const body = JSON.parse(init.body);
  assert.equal(body.to, 'amar.p3x9.globex@apply.vloombox.in');
  assert.deepEqual(body.codes, ['482913']);
  assert.equal(body.raw_key, key);
  assert.equal(body.is_human, false);
});

test('deliver(): 3 tries max on network errors, no retry on 401', async () => {
  let n = 0;
  const r1 = await deliver({ AA_API_BASE: 'https://x', AA_INBOUND_SECRET: 's' }, { raw_key: null },
    { fetchImpl: async () => { n++; throw new Error('boom'); }, sleep: async () => {} });
  assert.equal(r1.ok, false);
  assert.equal(n, 3);
  n = 0;
  const r2 = await deliver({ AA_API_BASE: 'https://x', AA_INBOUND_SECRET: 's' }, { raw_key: null },
    { fetchImpl: async () => { n++; return new Response('', { status: 401 }); }, sleep: async () => {} });
  assert.equal(r2.ok, false);
  assert.equal(n, 1);
});

test('email(): over 10 MB is rejected, nothing stored or posted', async () => {
  const { env, store } = fakeEnv();
  const pending = [];
  const msg = fakeMessage('Subject: x\r\n\r\nhi', { rawSize: 10 * 1024 * 1024 + 1 });
  await worker.email(msg, env, { waitUntil: (p) => pending.push(p) });
  assert.match(msg.rejected, /too large/);
  assert.equal(store.size, 0);
  assert.equal(pending.length, 0);
});

test('email(): unknown alias is accepted and forwarded (API stores user_id NULL)', async (t) => {
  const { env } = fakeEnv();
  const realFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_u, init) => { body = JSON.parse(init.body); return new Response('{}'); };
  t.after(() => { globalThis.fetch = realFetch; });
  const pending = [];
  const msg = fakeMessage('From: a@b.com\r\nSubject: hi\r\n\r\nhello', { to: 'nobody@apply.vloombox.in' });
  await worker.email(msg, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.equal(msg.rejected, null);
  assert.equal(body.to, 'nobody@apply.vloombox.in');
});

test('email(): R2 failure still delivers with raw_key null', async (t) => {
  const { env } = fakeEnv();
  env.AA_MAIL.put = async () => { throw new Error('r2 down'); };
  const realFetch = globalThis.fetch;
  const realErr = console.error;
  console.error = () => {};
  let body;
  globalThis.fetch = async (_u, init) => { body = JSON.parse(init.body); return new Response('{}'); };
  t.after(() => { globalThis.fetch = realFetch; console.error = realErr; });
  const pending = [];
  await worker.email(fakeMessage('From: a@b.com\r\nSubject: hi\r\n\r\nhello'), env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.equal(body.raw_key, null);
});

// Vloombox AutoApply inbound mail worker (Cloudflare Email Workers).
//
// Catch-all for *@apply.vloombox.in: keep the raw .eml in R2, extract verification codes / links,
// POST the contract body (docs/autoapply-contract.md, "Inbound mail") to the API, HMAC signed.
// Mail is never bounced for an unknown alias: the API stores it with user_id NULL. Only obvious abuse
// (over 10 MB, or a recipient local part longer than RFC 5321 allows) is rejected.

import PostalMime from 'postal-mime';
import { MAX_BYTES, buildPayload, rawKeyFor } from './extract.js';

export const RETRY = { tries: 3, baseMs: 1000 };   // waits 1 s, then 3 s between tries

const enc = new TextEncoder();

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** hex(HMAC_SHA256(secret, `${ts}.${rawBody}`)) via WebCrypto. */
export async function sign(secret, ts, rawBody) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}.${rawBody}`)));
}

const retryable = (status) => status >= 500 || status === 408 || status === 429;

/** POST the payload to the API; a fresh timestamp + signature per try (the API allows 60 s skew). */
export async function deliver(env, payload, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const url = `${String(env.AA_API_BASE || '').replace(/\/+$/, '')}/api/inbound/email`;
  const rawBody = JSON.stringify(payload);
  let last = '';
  for (let attempt = 1; attempt <= RETRY.tries; attempt++) {
    try {
      const ts = String(Math.floor(Date.now() / 1000));
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AA-Timestamp': ts,
          'X-AA-Signature': await sign(env.AA_INBOUND_SECRET, ts, rawBody),
        },
        body: rawBody,
      });
      if (res.ok) return { ok: true, status: res.status, attempts: attempt };
      last = `HTTP ${res.status}`;
      if (!retryable(res.status)) break;
    } catch (e) {
      last = String(e && e.message ? e.message : e);
    }
    if (attempt < RETRY.tries) await sleep(RETRY.baseMs * (3 ** (attempt - 1)));
  }
  console.error(JSON.stringify({ msg: 'inbound delivery failed', error: last, raw_key: payload.raw_key, to: payload.to }));
  return { ok: false, error: last };
}

export default {
  async email(message, env, ctx) {
    const to = String(message.to || '').toLowerCase();
    const local = to.split('@')[0] || '';
    if (local.length > 64) {
      message.setReject('550 5.1.3 Invalid recipient address');
      return;
    }
    if (Number(message.rawSize) > MAX_BYTES) {
      message.setReject('552 5.3.4 Message too large (limit 10 MB)');
      return;
    }

    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    if (raw.byteLength > MAX_BYTES) {
      message.setReject('552 5.3.4 Message too large (limit 10 MB)');
      return;
    }

    const now = new Date();
    let rawKey = rawKeyFor(now, crypto.randomUUID());
    try {
      await env.AA_MAIL.put(rawKey, raw, {
        httpMetadata: { contentType: 'message/rfc822' },
        customMetadata: { to, envelope_from: String(message.from || '').slice(0, 256) },
      });
    } catch (e) {
      console.error(JSON.stringify({ msg: 'r2 put failed', error: String(e), to }));
      rawKey = null;
    }

    let parsed;
    try {
      parsed = await PostalMime.parse(raw);
    } catch (e) {
      console.error(JSON.stringify({ msg: 'parse failed', error: String(e), raw_key: rawKey }));
      parsed = { headers: [], subject: message.headers?.get?.('subject') || '', text: '', html: '' };
    }

    const payload = buildPayload(parsed, { envelopeTo: to, envelopeFrom: message.from, receivedAt: now, rawKey });
    console.log(JSON.stringify({ msg: 'mail', to, from: payload.from, codes: payload.codes.length, links: payload.links.length, is_human: payload.is_human, raw_key: rawKey }));
    ctx.waitUntil(deliver(env, payload));
  },
};

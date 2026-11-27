// Vloombox AutoApply inbound mail worker (Cloudflare Email Workers).
//
// Catch-all for *@apply.vloombox.in: keep the raw .eml in R2, extract verification codes / links,
// POST the contract body (docs/autoapply-contract.md, "Inbound mail") to the API, HMAC signed.
// Mail is never bounced for an unknown alias: the API stores it with user_id NULL. Only obvious abuse
// (over 10 MB, or a recipient local part longer than RFC 5321 allows) is rejected.

import PostalMime from 'postal-mime';
import { MAX_BYTES, buildPayload, rawKeyFor } from './extract.js';

export const RETRY = { tries: 3, baseMs: 1000 };   // waits 1 s, then 3 s between tries
// Durable retry (D1 table pending_mail): a payload whose quick tries all failed is saved and re-delivered by the
// every-5-minutes cron with a fresh HMAC, until it succeeds or is 3 days old.
export const DURABLE = { giveUpMs: 3 * 24 * 3600 * 1000, backoffBaseMs: 5 * 60 * 1000, backoffMaxMs: 60 * 60 * 1000, batch: 10 };

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
// A 4xx the API will never accept (malformed payload) is dropped, not parked. 401/403 (secret mismatch) and 404
// (wrong base URL) are config problems that a fix + the cron can recover from, so those are parked.
export const isPoison = (status) => Number.isInteger(status) && status >= 400 && status < 500 && ![401, 403, 404, 408, 429].includes(status);

/** POST the payload to the API; a fresh timestamp + signature per try (the API allows 60 s skew). */
export async function deliver(env, payload, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tries = RETRY.tries } = {}) {
  const url = `${String(env.AA_API_BASE || '').replace(/\/+$/, '')}/api/inbound/email`;
  const rawBody = JSON.stringify(payload);
  let last = '';
  let lastStatus = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
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
      lastStatus = res.status;
      if (!retryable(res.status)) break;
    } catch (e) {
      last = String(e && e.message ? e.message : e);
      lastStatus = null;
    }
    if (attempt < tries) await sleep(RETRY.baseMs * (3 ** (attempt - 1)));
  }
  console.error(JSON.stringify({ msg: 'inbound delivery failed', error: last, raw_key: payload.raw_key, to: redactAddr(payload.to) }));
  return { ok: false, error: last, status: lastStatus };
}

/** Log-safe address: keeps the domain, hides the local part (it contains the user's name / alias). */
export function redactAddr(addr) {
  const a = String(addr || '');
  const at = a.lastIndexOf('@');
  if (at < 0) return a ? '***' : '';
  return `${a.slice(0, 1)}***${a.slice(at)}`;
}
const fromDomain = (addr) => { const a = String(addr || ''); const at = a.lastIndexOf('@'); return at < 0 ? '' : a.slice(at + 1).toLowerCase(); };

/** Parked payloads keep verification codes / links only this long: they are useless (expired) after, and sensitive. */
export const SCRUB_AFTER_MS = 15 * 60 * 1000;

/** Cron: blank `codes` and `links` of parked rows older than 15 minutes (the rest of the payload still re-delivers). */
export async function scrubParked(env, now = Date.now) {
  if (!env.AA_PENDING) return;
  try {
    await env.AA_PENDING.prepare(
      "UPDATE pending_mail SET payload = json_set(payload, '$.codes', json('[]'), '$.links', json('[]')) " +
      "WHERE created_at < ?1 AND (json_array_length(payload, '$.codes') > 0 OR json_array_length(payload, '$.links') > 0)",
    ).bind(now() - SCRUB_AFTER_MS).run();
  } catch (e) {
    console.error(JSON.stringify({ msg: 'scrub failed', error: String(e) }));
  }
}

/** Quick tries first; on final failure park the payload in D1 (when bound) for the cron to retry. */
export async function deliverOrPark(env, payload, opts = {}) {
  const r = await deliver(env, payload, opts);
  if (r.ok) return r;
  if (isPoison(r.status)) {
    console.error(JSON.stringify({ msg: 'dropping unacceptable payload', status: r.status, to: redactAddr(payload.to), raw_key: payload.raw_key }));
    return { ...r, parked: false, dropped: true };
  }
  if (!env.AA_PENDING) {
    console.error(JSON.stringify({ msg: 'no AA_PENDING binding; mail not parked', raw_key: payload.raw_key, to: redactAddr(payload.to) }));
    return { ...r, parked: false };
  }
  try {
    const now = opts.now ? opts.now() : Date.now();
    await env.AA_PENDING.prepare(
      'INSERT INTO pending_mail (id, payload, created_at, next_attempt_at, attempts, last_error) VALUES (?1, ?2, ?3, ?4, 0, ?5)',
    ).bind(crypto.randomUUID(), JSON.stringify(payload), now, now + DURABLE.backoffBaseMs, String(r.error || '').slice(0, 200)).run();
    return { ...r, parked: true };
  } catch (e) {
    console.error(JSON.stringify({ msg: 'parking failed', error: String(e), raw_key: payload.raw_key, to: redactAddr(payload.to) }));
    return { ...r, parked: false };
  }
}

/** Cron: re-deliver parked payloads (fresh HMAC each time), delete on success, give up after 3 days. */
export async function retryPending(env, { fetchImpl = fetch, now = Date.now } = {}) {
  const out = { delivered: 0, failed: 0, gave_up: 0, dropped: 0 };
  if (!env.AA_PENDING) return out;
  await scrubParked(env, now);
  const t = now();
  const { results } = await env.AA_PENDING.prepare(
    'SELECT id, payload, created_at, attempts FROM pending_mail WHERE next_attempt_at <= ?1 ORDER BY created_at LIMIT ?2',
  ).bind(t, DURABLE.batch).all();
  for (const row of results || []) {
    const del = () => env.AA_PENDING.prepare('DELETE FROM pending_mail WHERE id = ?1').bind(row.id).run();
    if (t - row.created_at > DURABLE.giveUpMs) {
      console.error(JSON.stringify({ msg: 'giving up on parked mail after 3 days', id: row.id }));
      await del();
      out.gave_up++;
      continue;
    }
    let payload;
    try { payload = JSON.parse(row.payload); } catch { await del(); out.dropped++; continue; }
    const r = await deliver(env, payload, { fetchImpl, tries: 1 });
    if (r.ok) { await del(); out.delivered++; continue; }
    if (isPoison(r.status)) { await del(); out.dropped++; continue; }
    const wait = Math.min(DURABLE.backoffMaxMs, DURABLE.backoffBaseMs * 2 ** Math.min(row.attempts + 1, 6));
    await env.AA_PENDING.prepare('UPDATE pending_mail SET attempts = attempts + 1, next_attempt_at = ?2, last_error = ?3 WHERE id = ?1')
      .bind(row.id, t + wait, String(r.error || '').slice(0, 200)).run();
    out.failed++;
  }
  return out;
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
    // Raw copies are optional: without an R2 bucket bound (R2 needs a card on file) the codes, links and text
    // excerpt still reach the API; only the full .eml archive is skipped.
    let rawKey = env.AA_MAIL ? rawKeyFor(now, crypto.randomUUID()) : null;
    if (rawKey) try {
      await env.AA_MAIL.put(rawKey, raw, {
        httpMetadata: { contentType: 'message/rfc822' },
        customMetadata: { to, envelope_from: String(message.from || '').slice(0, 256) },
      });
    } catch (e) {
      console.error(JSON.stringify({ msg: 'r2 put failed', error: String(e), to: redactAddr(to) }));
      rawKey = null;
    }

    let parsed;
    try {
      parsed = await PostalMime.parse(raw);
    } catch (e) {
      console.error(JSON.stringify({ msg: 'parse failed', error: String(e), raw_key: rawKey }));
      parsed = { headers: [], subject: message.headers?.get?.('subject') || '', text: '', html: '' };
    }

    // AA_AUTHSERV_IDS (comma list) overrides the trusted authserv-id (default mx.cloudflare.net)
    const trustedAuthserv = env.AA_AUTHSERV_IDS ? String(env.AA_AUTHSERV_IDS).split(',') : undefined;
    const payload = buildPayload(parsed, { envelopeTo: to, envelopeFrom: message.from, receivedAt: now, rawKey, trustedAuthserv });
    console.log(JSON.stringify({ msg: 'mail', to: redactAddr(to), from_domain: fromDomain(payload.from), codes: payload.codes.length, links: payload.links.length, is_human: payload.is_human, auth: payload.auth && payload.auth.dmarc, raw_key: rawKey }));
    ctx.waitUntil(deliverOrPark(env, payload));
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(retryPending(env).then((r) => { if (r.delivered || r.failed || r.gave_up || r.dropped) console.log(JSON.stringify({ msg: 'pending retry', ...r })); }));
  },
};

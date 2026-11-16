/**
 * Inbound mail from the Email Worker (contract: "Inbound mail").
 *   X-AA-Timestamp: unix seconds
 *   X-AA-Signature: hex(HMAC_SHA256(AA_INBOUND_SECRET, `${ts}.${rawBody}`))
 */
import crypto from "node:crypto";

export const MAX_SKEW_S = 60;

export function signInbound(secret, ts, rawBody) {
  return crypto.createHmac("sha256", secret).update(`${ts}.`).update(rawBody).digest("hex");
}

/** @returns {{ok: true} | {ok: false, code: string}} */
export function verifyInbound({ secret, timestamp, signature, rawBody, nowS = Math.floor(Date.now() / 1000) }) {
  if (!secret) return { ok: false, code: "inbound_unconfigured" };
  const ts = Number(timestamp);
  if (!timestamp || !Number.isFinite(ts) || !/^\d+$/.test(String(timestamp).trim())) return { ok: false, code: "bad_timestamp" };
  if (Math.abs(nowS - ts) > MAX_SKEW_S) return { ok: false, code: "stale_timestamp" };
  const sig = String(signature || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false, code: "bad_signature" };
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
  const expected = Buffer.from(signInbound(secret, String(timestamp).trim(), body), "hex");
  const got = Buffer.from(sig, "hex");
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return { ok: false, code: "bad_signature" };
  return { ok: true };
}

/** 'first.k7q2.acme@apply.vloombox.in' -> { local: 'first.k7q2.acme', alias: 'first.k7q2', tag: 'acme' } */
export function parseAlias(to) {
  const addr = String(to || "").trim().toLowerCase();
  const m = /<([^>]+)>/.exec(addr);
  const email = (m ? m[1] : addr).trim();
  const local = email.split("@")[0] || "";
  const parts = local.split(".");
  const alias = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : local;
  const tag = parts.length > 2 ? parts.slice(2).join(".") : null;
  return { local, alias, tag };
}

const strArr = (v, max, len) =>
  (Array.isArray(v) ? v : []).filter((x) => typeof x === "string" && x).slice(0, max).map((x) => x.slice(0, len));

/**
 * Store one inbound mail. Returns { event, profile } (profile null for an
 * unknown alias). Does NOT forward — the caller does that after responding.
 */
export async function storeInbound({ db, payload }) {
  const p = payload || {};
  const { local, alias } = parseAlias(p.to);
  if (!local) {
    const e = new Error("missing 'to'");
    e.status = 400;
    e.code = "invalid_input";
    throw e;
  }

  const { data: profile, error: pErr } = await db
    .from("aa_profiles")
    .select("user_id, contact_email, apply_alias")
    .eq("apply_alias", alias)
    .maybeSingle();
  if (pErr) throw pErr;

  const receivedAt = p.received_at && !Number.isNaN(Date.parse(p.received_at)) ? new Date(p.received_at).toISOString() : new Date().toISOString();
  const row = {
    user_id: profile ? profile.user_id : null,
    alias: local.slice(0, 200),
    sender: String(p.from || "unknown").slice(0, 320),
    subject: p.subject == null ? null : String(p.subject).slice(0, 500),
    codes: strArr(p.codes, 20, 64),
    links: strArr(p.links, 50, 2000),
    is_human: p.is_human === true,
    text_excerpt: p.text_excerpt == null ? null : String(p.text_excerpt).slice(0, 2000),
    raw_ref: p.raw_key == null ? null : String(p.raw_key).slice(0, 500),
    received_at: receivedAt,
  };
  const { data: event, error } = await db.from("aa_mail_events").insert(row).select("*").single();
  if (error) throw error;

  if (profile) {
    const { error: nErr } = await db.rpc("aa_notify_mail", { p_user: profile.user_id, p_event: event.id });
    if (nErr) console.warn("[autoapply/inbound] aa_notify_mail failed:", nErr.message || nErr);
  }
  return { event, profile: profile || null };
}

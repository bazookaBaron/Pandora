/**
 * Inbound mail from the Email Worker (contract: "Inbound mail").
 *   X-AA-Timestamp: unix seconds
 *   X-AA-Signature: hex(HMAC_SHA256(AA_INBOUND_SECRET, `${ts}.${rawBody}`))
 */
import crypto from "node:crypto";
import { classifyMail, expiresAtFor, companyFromMail } from "./classify.js";
import { extractInterview } from "./interview.js";

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

/**
 * Dedupe key for one stored mail (aa_mail_events.dedupe_key, unique: sql/mail/03_mail_dedupe.sql).
 * The Email Worker retries a delivery whose response it never saw (timeout, 5xx after the insert, the D1 retry
 * cron), always with the SAME payload. Key = sha256(recipient local part + Message-ID); a mail without a
 * Message-ID falls back to sha256 of the payload fields that a retry repeats verbatim (raw_key is a fresh R2 key
 * per received mail, so two genuinely different mails never collide). Per recipient: the same message sent to
 * two aliases is two mails.
 */
export function mailDedupeKey(payload) {
  const p = payload || {};
  const { local } = parseAlias(p.to);
  const mid = String(p.message_id || "").trim().replace(/^<|>$/g, "").toLowerCase();
  const material = mid
    ? `mid\n${local}\n${mid}`
    : `raw\n${local}\n${String(p.from || "").toLowerCase()}\n${p.subject ?? ""}\n${p.received_at ?? ""}\n${p.raw_key ?? ""}\n${String(p.text_excerpt ?? "").slice(0, 500)}`;
  return crypto.createHash("sha256").update(material, "utf8").digest("hex");
}

// The column / unique index is not there yet (main-db fallback, or sql/mail/03 not applied): store without it.
const isMissingDedupe = (err) =>
  !!err && (["PGRST204", "42703", "42P10"].includes(err.code) || /dedupe_key|no unique or exclusion constraint/i.test(String(err.message || "")));

const strArr = (v, max, len) =>
  (Array.isArray(v) ? v : []).filter((x) => typeof x === "string" && x).slice(0, max).map((x) => x.slice(0, len));


/**
 * Store one inbound mail. The alias is resolved against the MAIN db (aa_profiles); the mail row goes to the
 * MAIL db (`mailDb`, defaults to `db`) with a category, kind and expires_at (NULL = kept), plus an aa_interviews
 * row for an interview mail. Returns { event, profile, category, kind, interview, duplicate }
 * (profile null for an unknown alias; duplicate true + event null when this mail was already stored, see
 * mailDedupeKey). Mail is never forwarded anywhere; alerts are the caller's job and must skip duplicates.
 */
export async function storeInbound({ db, mailDb = db, payload }) {
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
    .select("user_id, contact_email, apply_alias, alert_prefs")
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
    has_attachments: p.has_attachments === true,
  };
  // Not stored: the calendar invite text and meeting links only feed the classifier / interview extractor.
  const ics = typeof p.ics === "string" && p.ics ? p.ics.slice(0, 32_000) : null;
  const meetingLinks = strArr(p.meeting_links, 10, 2000);
  const fromName = p.from_name == null ? null : String(p.from_name).slice(0, 200);
  const { category, kind } = classifyMail({ ...row, ics, meeting_links: meetingLinks });
  row.category = category;
  row.kind = kind;
  row.from_name = fromName;
  row.company = companyFromMail({ sender: row.sender, from_name: fromName, subject: row.subject });
  row.read_at = null;
  // Only received / rejected mail expires (30 days); retention counts from arrival at Vloombox, so a late
  // retry from the worker is not deleted at once. Everything else keeps expires_at NULL = never deleted.
  row.expires_at = expiresAtFor(category, new Date());
  row.dedupe_key = mailDedupeKey(p);
  // INSERT ... ON CONFLICT (dedupe_key) DO NOTHING: a retried delivery inserts nothing and returns no row.
  let { data: inserted, error } = await mailDb
    .from("aa_mail_events")
    .upsert(row, { onConflict: "dedupe_key", ignoreDuplicates: true })
    .select("*");
  if (error && isMissingDedupe(error)) {
    console.warn("[autoapply/inbound] dedupe_key unavailable, storing without it:", error.message || error.code);
    const { dedupe_key: _k, ...plain } = row;
    ({ data: inserted, error } = await mailDb.from("aa_mail_events").insert(plain).select("*"));
  }
  if (error) throw error;
  const event = inserted && inserted[0];
  if (!event) {
    // Already stored by an earlier delivery of the same mail: no interview row, no notify, no push.
    return { event: null, profile: profile || null, category, kind, interview: null, duplicate: true };
  }

  let interview = null;
  if (kind === "interview" && event.user_id) {
    const x = extractInterview({ ...row, ics, meeting_links: meetingLinks, received_at: receivedAt });
    if (x) {
      const rec = { mail_event_id: event.id, user_id: event.user_id, ...x };
      const { data: saved, error: iErr } = await mailDb.from("aa_interviews").insert(rec).select("*").single();
      if (iErr) console.warn("[autoapply/inbound] aa_interviews insert failed:", iErr.message || iErr);
      else interview = saved;
    }
  }

  if (profile) {
    const { error: nErr } = await mailDb.rpc("aa_notify_mail", { p_user: profile.user_id, p_event: event.id });
    if (nErr) console.warn("[autoapply/inbound] aa_notify_mail failed:", nErr.message || nErr);
  }
  return { event, profile: profile || null, category, kind, interview, duplicate: false };
}

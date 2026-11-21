/**
 * Scheduled mail jobs (run from server.js crons on Railway):
 *   cleanupExpiredMail  daily: delete expired code (7 d) / received / rejected (30 d) rows, and every row of an
 *                       unknown alias (user_id NULL, 3 d), from the mail db in batches (this daily activity also
 *                       keeps the free Supabase project from pausing). A user's rows with expires_at NULL
 *                       (important, other) are never deleted.
 *   sendDailyAlerts     daily ~7 PM IST: ONE short email per user with unalerted interview / assessment / offer /
 *                       rejection / other important mail
 *   backfillMail        one-off (scripts/aa-mail-backfill.mjs): re-classify old rows, set kind / company /
 *                       expires_at, extract interviews
 */
import { classifyMail, companyFromMail, mailExpiresAt, NOTIFY_CATEGORIES, RETENTION_DAYS } from "./classify.js";
import { extractInterview } from "./interview.js";

/** The only categories the cleanup may delete (belt and braces next to expires_at NULL). */
export const EXPIRING_CATEGORIES = Object.keys(RETENTION_DAYS).filter((c) => RETENTION_DAYS[c] != null);
export const ALERT_MAX_SENDS = 100;
export const ALERT_LOOKBACK_MS = 24 * 3600 * 1000;

export async function cleanupExpiredMail({ mailDb, now = new Date(), batchSize = 500, maxBatches = 200 } = {}) {
  let deleted = 0;
  // pass 1: the user's expiring categories; pass 2: unknown-alias mail (user_id NULL), any category
  const passes = [(q) => q.in("category", EXPIRING_CATEGORIES), (q) => q.is("user_id", null)];
  for (const scope of passes) {
    for (let i = 0; i < maxBatches; i++) {
      const { data, error } = await scope(mailDb.from("aa_mail_events").select("id"))
        .lt("expires_at", now.toISOString())
        .order("expires_at", { ascending: true })
        .limit(batchSize);
      if (error) throw error;
      const ids = (data || []).map((r) => r.id);
      if (!ids.length) break;
      const { error: dErr } = await mailDb.from("aa_mail_events").delete().in("id", ids);
      if (dErr) throw dErr;
      deleted += ids.length;
      if (ids.length < batchSize) break;
    }
  }
  return { deleted };
}

function companyFromSender(ev) {
  return ev.company || companyFromMail({ sender: ev.sender, from_name: ev.from_name, subject: ev.subject });
}

const KIND_WORDS = { interview: ["interview", "interviews"], assessment: ["assessment", "assessments"], offer: ["offer", "offers"], rejection: ["application update", "application updates"] };
const KINDS = [
  [/\bassessments?\b|\btest\b|\bcoding (challenge|round)\b|hackerrank|codility|codesignal|mettl|hirevue/i, "assessment"],
  [/\binterview|schedule (a|your) (call|meeting)|video (call|screen)/i, "interview"],
  [/\boffer\b/i, "offer"],
];

function kindOf(ev) {
  if (ev.kind && KIND_WORDS[ev.kind]) return ev.kind;
  if (ev.category === "rejected") return "rejection";
  const text = `${ev.subject || ""} ${String(ev.text_excerpt || "").slice(0, 300)}`;
  const k = KINDS.find(([re]) => re.test(text));
  return k ? k[1] : "message";
}

/** Short human summary, e.g. { n: 3, example: '1 assessment from Ibm' }. Never includes the mail body. */
export function describeAlert(events) {
  const groups = new Map();
  for (const ev of events) {
    const key = kindOf(ev);
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  const [kindKey, kindCount] = [...groups.entries()].sort((a, b) => b[1] - a[1])[0];
  const words = KIND_WORDS[kindKey] || ["message", "messages"];
  const first = events.find((e) => kindOf(e) === kindKey) || events[0];
  const comp = companyFromSender(first);
  return { n: events.length, example: `${kindCount} ${kindCount === 1 ? words[0] : words[1]}${comp ? ` from ${comp}` : ""}` };
}

export function buildAlertEmail({ events, baseUrl }) {
  const { n, example } = describeAlert(events);
  const link = `${String(baseUrl || "https://www.vloombox.in").replace(/\/+$/, "")}/autoapply/inbox`;
  const noun = n === 1 ? "message" : "messages";
  const subject = `You have ${n} new ${noun} in Vloombox`;
  const safe = example.replace(/[<>&"]/g, "");
  return {
    subject,
    text: `You have ${n} new ${noun} in Vloombox (e.g. ${example}).\nOpen: ${link}`,
    html: `<p>You have <strong>${n}</strong> new ${noun} in Vloombox (e.g. ${safe}).</p><p><a href="${link}">Open your Vloombox inbox</a></p>`,
    tag: "autoapply-alert",
  };
}

/**
 * @param {{db: object, mailDb: object, resend: {sendEmail: Function}, getAuthEmail?: (uid: string) => Promise<string|null>,
 *          baseUrl?: string, now?: Date, maxSends?: number}} deps
 */
export async function sendDailyAlerts({ db, mailDb, resend, getAuthEmail = async () => null, baseUrl = process.env.APP_BASE_URL, now = new Date(), maxSends = ALERT_MAX_SENDS }) {
  const since = new Date(now.getTime() - ALERT_LOOKBACK_MS).toISOString();
  const { data: rows, error } = await mailDb
    .from("aa_mail_events")
    .select("id, user_id, sender, from_name, company, subject, text_excerpt, received_at, category, kind")
    .in("category", NOTIFY_CATEGORIES)
    .is("alerted_at", null)
    .gte("received_at", since)
    .order("received_at", { ascending: true })
    .limit(2000);
  if (error) throw error;

  const byUser = new Map();
  for (const r of rows || []) {
    if (!r.user_id) continue;
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }

  // Every API replica runs this cron: each user's rows are CLAIMED (alerted_at = this run's stamp, only where
  // still NULL, RETURNING id) before the email goes out, so a second replica finds nothing left to send. A failed
  // or skipped send hands the claimed rows back (alerted_at -> NULL, only rows carrying this run's stamp).
  const stamp = now.toISOString();
  const stats = { users: byUser.size, sent: 0, skipped: 0, failed: 0, deferred: 0, claimed_elsewhere: 0 };
  for (const [uid, events] of byUser) {
    if (stats.sent >= maxSends) { stats.deferred++; continue; }   // leftovers go to the next run
    const { data: claimedRows, error: cErr } = await mailDb
      .from("aa_mail_events")
      .update({ alerted_at: stamp })
      .in("id", events.map((e) => e.id))
      .is("alerted_at", null)
      .select("id");
    if (cErr) { console.error("[autoapply/alerts] claim failed:", cErr.message || cErr); stats.failed++; continue; }
    const mine = new Set((claimedRows || []).map((r) => r.id));
    const claimed = events.filter((e) => mine.has(e.id));
    if (!claimed.length) { stats.claimed_elsewhere++; continue; }
    const giveBack = () => mailDb.from("aa_mail_events").update({ alerted_at: null }).in("id", [...mine]).eq("alerted_at", stamp);

    const { data: prof } = await db.from("aa_profiles").select("contact_email, alert_prefs").eq("user_id", uid).maybeSingle();
    const prefs = (prof && prof.alert_prefs) || {};
    if (prefs.email === false) { stats.skipped++; continue; }     // stays alerted: the user opted out
    const to = (prof && prof.contact_email) || (await getAuthEmail(uid));
    if (!to) { stats.skipped++; continue; }
    try {
      const r = await resend.sendEmail({ to, ...buildAlertEmail({ events: [...claimed].reverse(), baseUrl }) });
      if (r && r.id) stats.sent++;
      else if (r && r.skipped) { await giveBack(); stats.skipped++; }   // Resend not configured: leave unalerted
      else { await giveBack(); stats.failed++; }
    } catch (e) {
      console.error("[autoapply/alerts]", (e && e.message) || String(e));
      await giveBack();
      stats.failed++;
    }
  }
  return stats;
}

/**
 * One-off backfill for rows stored before categories rejected / kind / company and NULL expiry existed.
 * Re-classifies each row (a row the Python bot already consumed keeps working: category is only a tie-breaker),
 * sets expires_at from received_at (NULL = kept), and creates aa_interviews rows for interview mail.
 * Idempotent: rows are walked by id; an interview row is only inserted once per mail (unique mail_event_id).
 */
export async function backfillMail({ mailDb, batchSize = 500, maxBatches = 1000, afterId = 0, log = () => {} } = {}) {
  const stats = { scanned: 0, updated: 0, interviews: 0, rejected: 0, received: 0 };
  let cursor = afterId;
  for (let i = 0; i < maxBatches; i++) {
    const { data, error } = await mailDb
      .from("aa_mail_events")
      .select("id, user_id, sender, from_name, subject, codes, links, is_human, text_excerpt, received_at, category, kind, company, expires_at")
      .gt("id", cursor)
      .order("id", { ascending: true })
      .limit(batchSize);
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) break;
    for (const r of rows) {
      stats.scanned++;
      cursor = r.id;
      // A row with `kind` set was classified on arrival by the current classifier, which also saw the calendar
      // invite and meeting links (never stored). Re-classifying it here without them could turn a kept interview
      // invite into an expiring 'received' / 'rejected' row (the cleanup would then delete it and, by cascade,
      // its aa_interviews row), so its category and kind are kept as stored.
      const trusted = r.kind != null && Object.hasOwn(RETENTION_DAYS, r.category);
      const { category, kind } = trusted ? { category: r.category, kind: r.kind } : classifyMail(r);
      const company = r.company || companyFromMail({ sender: r.sender, from_name: r.from_name, subject: r.subject });
      const expires_at = mailExpiresAt({ category, user_id: r.user_id }, r.received_at || new Date());
      if (category === "rejected") stats.rejected++;
      if (category === "received") stats.received++;
      // compare instants, not strings: Postgres returns '+00:00' where toISOString() writes 'Z'
      const sameExpiry =
        expires_at == null || r.expires_at == null ? (expires_at ?? null) === (r.expires_at ?? null) : Date.parse(expires_at) === Date.parse(r.expires_at);
      if (category !== r.category || kind !== (r.kind ?? null) || company !== (r.company ?? null) || !sameExpiry) {
        const { error: uErr } = await mailDb.from("aa_mail_events").update({ category, kind, company, expires_at }).eq("id", r.id);
        if (uErr) throw uErr;
        stats.updated++;
      }
      if (kind === "interview" && r.user_id) {
        const { data: have, error: hErr } = await mailDb.from("aa_interviews").select("id").eq("mail_event_id", r.id).maybeSingle();
        if (hErr) throw hErr;
        if (!have) {
          const x = extractInterview({ ...r, company });
          if (x) {
            const { error: iErr } = await mailDb.from("aa_interviews").insert({ mail_event_id: r.id, user_id: r.user_id, ...x });
            if (iErr) throw iErr;
            stats.interviews++;
          }
        }
      }
    }
    log({ ...stats, last_id: cursor });
    if (rows.length < batchSize) break;
  }
  return stats;
}

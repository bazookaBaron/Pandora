/**
 * Scheduled mail jobs (run from server.js crons on Railway):
 *   cleanupExpiredMail  daily: delete expired rows from the mail db in batches (this daily activity also
 *                       keeps the free Supabase project from pausing)
 *   sendDailyAlerts     daily ~7 PM IST: ONE short email per user with unalerted important mail
 */
export const ALERT_MAX_SENDS = 100;
export const ALERT_LOOKBACK_MS = 24 * 3600 * 1000;

export async function cleanupExpiredMail({ mailDb, now = new Date(), batchSize = 500, maxBatches = 200 } = {}) {
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const { data, error } = await mailDb
      .from("aa_mail_events")
      .select("id")
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
  return { deleted };
}

const GENERIC_LABELS = new Set([
  "com", "in", "co", "org", "net", "io", "uk", "us", "mail", "email", "careers", "jobs", "talent", "hr", "notifications",
  "myworkday", "myworkdayjobs", "greenhouse", "lever", "smartrecruiters", "icims", "taleo", "successfactors", "hackerrank", "hirevue",
]);

function companyFromSender(ev) {
  const m = /@([^>\s]+)/.exec(String(ev.sender || ""));
  if (!m) return null;
  const parts = m[1].toLowerCase().split(".").filter(Boolean);
  const pick = [...parts].reverse().find((p) => !GENERIC_LABELS.has(p) && p.length > 1);
  return pick ? pick[0].toUpperCase() + pick.slice(1) : null;
}

const KINDS = [
  [/\bassessments?\b|\btest\b|\bcoding (challenge|round)\b|hackerrank|codility|codesignal|mettl|hirevue/i, "assessment", "assessments"],
  [/\binterview|schedule (a|your) (call|meeting)|video (call|screen)/i, "interview", "interviews"],
  [/\boffer\b/i, "offer", "offers"],
];

/** Short human summary, e.g. { n: 3, example: '1 assessment from Ibm' }. Never includes the mail body. */
export function describeAlert(events) {
  const groups = new Map();
  for (const ev of events) {
    const text = `${ev.subject || ""} ${String(ev.text_excerpt || "").slice(0, 300)}`;
    const kind = KINDS.find(([re]) => re.test(text));
    const key = kind ? kind[1] : "message";
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  const [kindKey, kindCount] = [...groups.entries()].sort((a, b) => b[1] - a[1])[0];
  const plural = kindKey === "message" ? "messages" : KINDS.find((k) => k[1] === kindKey)[2];
  const comp = companyFromSender(events[0]);
  return { n: events.length, example: `${kindCount} ${kindCount === 1 ? kindKey : plural}${comp ? ` from ${comp}` : ""}` };
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
    .select("id, user_id, sender, subject, text_excerpt, received_at")
    .eq("category", "important")
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

  const stats = { users: byUser.size, sent: 0, skipped: 0, failed: 0, deferred: 0 };
  for (const [uid, events] of byUser) {
    const ids = events.map((e) => e.id);
    const { data: prof } = await db.from("aa_profiles").select("contact_email, alert_prefs").eq("user_id", uid).maybeSingle();
    const prefs = (prof && prof.alert_prefs) || {};
    const markAlerted = () => mailDb.from("aa_mail_events").update({ alerted_at: now.toISOString() }).in("id", ids);

    if (prefs.email === false) { await markAlerted(); stats.skipped++; continue; }
    if (stats.sent >= maxSends) { stats.deferred++; continue; }   // leftovers go to the next run
    const to = (prof && prof.contact_email) || (await getAuthEmail(uid));
    if (!to) { await markAlerted(); stats.skipped++; continue; }
    try {
      const r = await resend.sendEmail({ to, ...buildAlertEmail({ events: [...events].reverse(), baseUrl }) });
      if (r && r.id) { await markAlerted(); stats.sent++; }
      else if (r && r.skipped) stats.skipped++;      // Resend not configured: leave unalerted
      else stats.failed++;
    } catch (e) {
      console.error("[autoapply/alerts]", (e && e.message) || String(e));
      stats.failed++;
    }
  }
  return stats;
}

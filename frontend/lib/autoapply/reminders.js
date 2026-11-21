/**
 * Interview reminders: a web push 24 h and 1 h before each aa_interviews.starts_at (mail db).
 * Run every 5 minutes from server.js (runInterviewReminders in routes/autoapply.js).
 *
 * Idempotent: a reminder is CLAIMED first with a conditional update (reminder_24h_at / reminder_1h_at IS NULL ->
 * now, sql/mail/04_interview_reminders.sql) and only the run that won the claim sends it, so overlapping runs,
 * restarts or retries never push twice. If the cron was down and the 24 h slot was missed, only the 1 h one goes
 * out (the 24 h column is stamped too). Push subscriptions and alert prefs live in the MAIN db.
 */
import { sendPushToUser } from "./push.js";

const H = 3600 * 1000;
export const REMINDER_SLOTS = { "24h": 24 * H, "1h": H };
export const REMINDER_LOOKAHEAD_MS = 24 * H;
const IV_FIELDS = "id, user_id, company, role, round, starts_at, meeting_url, meeting_provider, mode, reminder_24h_at, reminder_1h_at";

const MEETING = { zoom: "Zoom", google_meet: "Google Meet", teams: "Microsoft Teams", webex: "Webex", chime: "Amazon Chime", skype: "Skype", hirevue: "HireVue" };
const clip = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

/** Which reminder is due for this interview at `now`: '1h' | '24h' | null. */
export function reminderDue(iv, now = new Date()) {
  const start = iv && iv.starts_at ? Date.parse(iv.starts_at) : NaN;
  if (Number.isNaN(start)) return null;
  const left = start - now.getTime();
  if (left <= 0) return null;
  if (left <= REMINDER_SLOTS["1h"]) return iv.reminder_1h_at ? null : "1h";
  if (left <= REMINDER_SLOTS["24h"]) return iv.reminder_24h_at ? null : "24h";
  return null;
}

/** "Tue, 24 Nov, 10:30 am IST" (interviews are read as India time when the mail names no zone). */
export function fmtIst(iso) {
  const d = new Date(iso);
  return `${d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} IST`;
}

export function reminderPayload(iv, which) {
  const company = clip(iv.company, 60);
  const lead = which === "1h" ? "Interview in 1 hour" : "Interview tomorrow";
  const how = MEETING[iv.meeting_provider] ? `Join on ${MEETING[iv.meeting_provider]}.` : iv.mode === "phone" ? "Phone call." : iv.mode === "onsite" ? "In person." : "";
  const what = [clip(iv.role, 60), clip(iv.round, 40)].filter(Boolean).join(" · ");
  return {
    title: `${lead}${company ? ` · ${company}` : ""}`,
    body: [what, fmtIst(iv.starts_at)].filter(Boolean).join(" · ") + (how ? `. ${how}` : ""),
    url: "/autoapply/interviews",
    tag: `aa-iv-${iv.id}-${which}`,
  };
}

/**
 * @param {{db: object, mailDb: object, now?: Date, send?: Function, env?: object, webpush?: object, limit?: number}} deps
 * @returns {Promise<{checked: number, sent: number, skipped: number, claimed_elsewhere: number}>}
 */
export async function sendInterviewReminders({ db, mailDb, now = new Date(), send = sendPushToUser, env, webpush, limit = 500 }) {
  const nowIso = now.toISOString();
  const until = new Date(now.getTime() + REMINDER_LOOKAHEAD_MS).toISOString();
  const { data, error } = await mailDb
    .from("aa_interviews")
    .select(IV_FIELDS)
    .gt("starts_at", nowIso)
    .lte("starts_at", until)
    .order("starts_at", { ascending: true })
    .limit(limit);
  if (error) throw error;

  const stats = { checked: 0, sent: 0, skipped: 0, claimed_elsewhere: 0 };
  const prefsCache = new Map();
  const prefsFor = async (uid) => {
    if (!prefsCache.has(uid)) {
      const { data: prof } = await db.from("aa_profiles").select("alert_prefs").eq("user_id", uid).maybeSingle();
      prefsCache.set(uid, (prof && prof.alert_prefs) || {});
    }
    return prefsCache.get(uid);
  };

  for (const iv of data || []) {
    stats.checked++;
    if (!iv.user_id) continue;
    const which = reminderDue(iv, now);
    if (!which) continue;
    const col = which === "1h" ? "reminder_1h_at" : "reminder_24h_at";
    const patch = { [col]: nowIso };
    if (which === "1h" && !iv.reminder_24h_at) patch.reminder_24h_at = nowIso; // missed slot: never send it late
    const { data: won, error: cErr } = await mailDb.from("aa_interviews").update(patch).eq("id", iv.id).is(col, null).select("id");
    if (cErr) throw cErr;
    if (!won || !won[0]) { stats.claimed_elsewhere++; continue; }
    const r = await send({ db, userId: iv.user_id, payload: reminderPayload(iv, which), prefs: await prefsFor(iv.user_id), env, webpush });
    if (r && r.sent > 0) stats.sent++;
    else stats.skipped++;
  }
  return stats;
}

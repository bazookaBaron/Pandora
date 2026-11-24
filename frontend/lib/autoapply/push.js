/**
 * Web push for AutoApply interview / assessment / offer / rejection / other important mail. Disabled (silently) unless VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY
 * are set. VAPID_SUBJECT defaults to mailto:support.vloombox@gmail.com. Never throws.
 */
const DEFAULT_SUBJECT = "mailto:support.vloombox@gmail.com";

export const vapidConfig = (env = process.env) =>
  env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
    ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || DEFAULT_SUBJECT }
    : null;

let realWebPush;
async function loadWebPush(env) {
  const cfg = vapidConfig(env);
  if (!cfg) return null;
  if (!realWebPush) {
    const mod = await import("web-push");
    realWebPush = mod.default || mod;
    realWebPush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);
  }
  return realWebPush;
}

// Push services a browser subscription may point at. Anything else (IP literals, other hosts, non-https,
// custom ports, credentials in the URL) is rejected so a subscription can't make the server POST to an
// arbitrary URL (SSRF).
const PUSH_HOSTS_EXACT = ["fcm.googleapis.com", "web.push.apple.com"];
const PUSH_HOST_SUFFIXES = [".push.services.mozilla.com", ".notify.windows.com"];

export function isAllowedPushEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > 2000) return false;
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const host = u.hostname.toLowerCase();
  if (!host || host.startsWith("[") || /^[0-9.]+$/.test(host) || host.includes(":")) return false; // IP literals
  if (PUSH_HOSTS_EXACT.includes(host)) return true;
  return PUSH_HOST_SUFFIXES.some((sfx) => host.endsWith(sfx) && host.length > sfx.length && /^[a-z0-9.-]+$/.test(host));
}

const clip = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

export function senderLabel(event) {
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(String(event.sender || ""));
  return clip(m ? m[1] : event.sender, 60) || "a company";
}

const PUSH_TITLE = {
  interview: "Interview invite",
  assessment: "Assessment to complete",
  offer: "Offer received",
  rejection: "Application update",
  recruiter: "Message from a recruiter",
};

export function pushPayload(event) {
  const kind = event.kind || (event.category === "rejected" ? "rejection" : null);
  const company = clip(event.company, 60);
  const title = PUSH_TITLE[kind] ? `${PUSH_TITLE[kind]}${company ? ` · ${company}` : ""}` : "Vloombox inbox";
  return {
    title,
    body: `New message from ${senderLabel(event)}: ${clip(event.subject, 100) || "(no subject)"}`,
    url: `/autoapply/inbox?mail=${event.id}`,
    tag: `aa-mail-${event.id}`,
  };
}

/**
 * Push one notification to every subscription of the user. Dead subscriptions (404/410) are removed.
 * @returns {Promise<{sent: number, removed: number, skipped?: string}>}
 */
export function sendPushForMail({ db, event, userId, prefs, env = process.env, webpush }) {
  return sendPushToUser({ db, userId, payload: pushPayload(event), prefs, env, webpush });
}

/** Push any {title, body, url, tag} payload to every subscription of the user (interview reminders use this). */
export async function sendPushToUser({ db, userId, payload, prefs, env = process.env, webpush }) {
  try {
    if (!userId) return { sent: 0, removed: 0, skipped: "no_user" };
    if (prefs && prefs.push === false) return { sent: 0, removed: 0, skipped: "opted_out" };
    const wp = webpush || (await loadWebPush(env));
    if (!wp) return { sent: 0, removed: 0, skipped: "disabled" };
    const { data: subs, error } = await db.from("aa_push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", userId);
    if (error) throw error;
    const body = JSON.stringify(payload);
    let sent = 0;
    const dead = [];
    for (const s of subs || []) {
      if (!isAllowedPushEndpoint(s.endpoint)) {
        dead.push(s.endpoint); // pre-allowlist row pointing somewhere else: drop it, never POST to it
        continue;
      }
      try {
        await wp.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 86400 });
        sent++;
      } catch (e) {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(s.endpoint);
        else console.warn("[autoapply/push] send failed:", (e && (e.statusCode || e.message)) || String(e));
      }
    }
    if (dead.length) await db.from("aa_push_subscriptions").delete().in("endpoint", dead);
    return { sent, removed: dead.length };
  } catch (e) {
    console.error("[autoapply/push]", (e && e.message) || String(e));
    return { sent: 0, removed: 0, skipped: "error" };
  }
}

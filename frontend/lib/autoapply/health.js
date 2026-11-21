/**
 * Admin health view over public.aa_health (sql/25) and the admin check. Pure, no I/O.
 *
 * Staleness matches cloud_hunter/saas/health.py: a row is stale when last_seen is older than 2 x its
 * stats.interval_s (fallback by component: discovery 4 h, scheduler 5 min, worker:* 1 min).
 *
 * Admins: there is no admin role in the app's auth, so admin access is an env allowlist on the server:
 *   AA_ADMIN_EMAILS   comma-separated emails (case-insensitive)
 *   AA_ADMIN_USER_IDS comma-separated auth user ids
 * Unset = nobody is an admin.
 */
export const DEFAULT_INTERVAL_S = { discovery: 4 * 3600, scheduler: 300, worker: 60 };

const list = (v) => String(v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export function isAdminUser(user, env = process.env) {
  if (!user) return false;
  const ids = list(env.AA_ADMIN_USER_IDS);
  const emails = list(env.AA_ADMIN_EMAILS);
  return (!!user.id && ids.includes(String(user.id).toLowerCase())) || (!!user.email && emails.includes(String(user.email).toLowerCase()));
}

export function intervalFor(row) {
  const s = row && row.stats && Number(row.stats.interval_s);
  if (Number.isFinite(s) && s > 0) return s;
  const comp = String((row && row.component) || "");
  return DEFAULT_INTERVAL_S[comp.split(":")[0]] || DEFAULT_INTERVAL_S.scheduler;
}

/** One aa_health row -> the row + { interval_s, age_s, stale, level: 'ok'|'warn'|'error'|'stale' }. */
export function healthView(row, now = new Date()) {
  const seen = Date.parse(row.last_seen);
  const interval = intervalFor(row);
  const age = Number.isNaN(seen) ? null : Math.max(0, Math.round((now.getTime() - seen) / 1000));
  const stale = age === null || age > 2 * interval;
  const status = ["ok", "warn", "error"].includes(row.status) ? row.status : "error";
  const level = status === "error" ? "error" : stale ? "stale" : status;
  return { ...row, status, interval_s: interval, age_s: age, stale, level };
}

const ORDER = { error: 0, stale: 1, warn: 2, ok: 3 };

export function healthSummary(rows, now = new Date()) {
  const items = (rows || []).map((r) => healthView(r, now)).sort((a, b) => ORDER[a.level] - ORDER[b.level] || String(a.component).localeCompare(String(b.component)));
  const counts = { ok: 0, warn: 0, stale: 0, error: 0 };
  for (const r of items) counts[r.level]++;
  return { now: now.toISOString(), counts, ok: counts.error === 0 && counts.stale === 0, components: items };
}

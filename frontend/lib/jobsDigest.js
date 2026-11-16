/**
 * Company-subscription job-alert digest (daily cron, 09:00 Asia/Kolkata).
 *
 * For every subscribed company, emails each subscriber one batched summary of
 * postings first seen in the last ~26h (sql/18: company_subscription_new_postings,
 * which skips duplicates and closed rows). Properties:
 *   - multi-instance safe: a `digest_runs` row (sql/29: claim_digest_run) lets
 *     exactly one instance run per day; the (user, posting) dedup log remains
 *     the second line of defence.
 *   - every `.in()` list is chunked (<= 100 ids per request) and every read is
 *     paged past PostgREST's 1000-row cap.
 *   - auth.admin.getUserById is memoized per user and fetched with a small
 *     concurrency.
 *   - Resend sends are throttled (default 2/sec) and retried on 429.
 *   - posting titles are HTML-escaped by the email template; links are limited
 *     to http(s) here before they ever reach it.
 *
 * Dependencies are injected so the helpers are unit-testable.
 */
import { chunk, safeHttpUrl, IN_CHUNK_SIZE } from "./jobsFeedUtil.js";

const PAGE = 1000;

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `fn(item)` over `items` with at most `limit` in flight; preserves order. */
export async function mapWithConcurrency(items, limit, fn) {
  const list = Array.from(items);
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker));
  return out;
}

/** Returns `wait()` which resolves so calls are spaced >= minIntervalMs apart. */
export function createThrottle(minIntervalMs, { now = Date.now, sleep = sleepReal } = {}) {
  let nextAt = 0;
  return async function wait() {
    const t = now();
    const at = Math.max(t, nextAt);
    nextAt = at + minIntervalMs;
    if (at > t) await sleep(at - t);
  };
}

/**
 * Call `send()` (a resend.sendEmail-style fn returning {id} | {error, status}),
 * retrying on 429 / transient 5xx with exponential backoff. Always returns the
 * last result.
 */
export async function sendWithRetry(send, { retries = 3, baseDelayMs = 1000, sleep = sleepReal } = {}) {
  let result = await send();
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const status = result && result.error ? Number(result.status) || 0 : 0;
    if (!(status === 429 || status >= 500)) break;
    await sleep(baseDelayMs * 2 ** attempt);
    result = await send();
  }
  return result;
}

/** Page through a PostgREST query builder factory `(from, to) => query`. */
export async function fetchAllPages(makeQuery, pageSize = PAGE) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await makeQuery(from, from + pageSize - 1);
    if (error) throw error;
    const got = data || [];
    rows.push(...got);
    if (got.length < pageSize) break;
  }
  return rows;
}

/** Keep only postings with a usable http(s) link; normalize the url. */
export function sanitizePostings(postings) {
  const out = [];
  for (const p of postings || []) {
    const url = safeHttpUrl(p && p.url);
    if (!url) continue;
    out.push({ ...p, url });
  }
  return out;
}

const istDate = (ms = Date.now()) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 10);
const isMissingFn = (e) => /PGRST202|42883|does not exist|Could not find the function/i.test(String((e && (e.code || e.message)) || e));

/**
 * @param {object} deps
 * @param {any} deps.supabaseAdmin
 * @param {{ isEnabled: () => boolean, sendEmail: (m:any) => Promise<any> }} deps.resend
 * @param {(a:any) => {subject:string,html:string,text:string}} deps.companyJobAlertEmail
 * @param {string} deps.appBaseUrl
 * @param {(s:string) => string} [deps.redact]
 * @param {number} [deps.sendsPerSecond]
 * @param {number} [deps.userConcurrency]
 */
export async function runCompanySubscriptionDigest(deps) {
  const {
    supabaseAdmin,
    resend,
    companyJobAlertEmail,
    appBaseUrl,
    redact = (s) => s,
    sendsPerSecond = 2,
    userConcurrency = 4,
    sleep = sleepReal,
  } = deps;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  if (!resend.isEnabled()) {
    console.error("[company-subs] digest skipped: RESEND_API_KEY is not set, no job alerts can be emailed");
    return;
  }

  const runDate = istDate();
  const instance = `${process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || "local"}:${process.pid}`;

  // Cross-instance claim — one runner per IST day (see sql/29).
  const claim = await supabaseAdmin.rpc("claim_digest_run", { p_run_date: runDate, p_instance: instance });
  if (claim.error) {
    if (!isMissingFn(claim.error)) {
      console.error("[company-subs] digest lock failed, skipping:", redact(claim.error.message || String(claim.error)));
      return;
    }
    console.warn("[company-subs] claim_digest_run() missing (run sql/29) — running without a cross-instance lock");
  } else if (claim.data !== true) {
    console.log("[company-subs] digest already claimed for", runDate);
    return;
  }

  const stats = { sent: 0, failed: 0, postings: 0 };
  let status = "done";
  try {
    const since = new Date(Date.now() - 26 * 3_600_000).toISOString();
    const newPostings = await fetchAllPages((from, to) =>
      supabaseAdmin.rpc("company_subscription_new_postings", { since }).range(from, to),
    );
    stats.postings = newPostings.length;

    if (newPostings.length) {
      const slugs = [...new Set(newPostings.map((p) => p.company_slug))];

      const subs = [];
      for (const part of chunk(slugs, IN_CHUNK_SIZE)) {
        subs.push(
          ...(await fetchAllPages((from, to) =>
            supabaseAdmin
              .from("company_subscriptions")
              .select("user_id, company_slug, company_name")
              .in("company_slug", part)
              .order("user_id")
              .range(from, to),
          )),
        );
      }

      const postingsByCompany = new Map();
      for (const p of newPostings) {
        if (!postingsByCompany.has(p.company_slug)) postingsByCompany.set(p.company_slug, []);
        postingsByCompany.get(p.company_slug).push(p);
      }

      const sentSet = new Set();
      for (const part of chunk([...new Set(newPostings.map((p) => p.id))], IN_CHUNK_SIZE)) {
        const rows = await fetchAllPages((from, to) =>
          supabaseAdmin
            .from("company_subscription_alerts_sent")
            .select("user_id, job_posting_id")
            .in("job_posting_id", part)
            .order("user_id")
            .order("job_posting_id")
            .range(from, to),
        );
        for (const r of rows) sentSet.add(`${r.user_id}:${r.job_posting_id}`);
      }

      // Work out who gets what first, then resolve each user's email once.
      const pending = [];
      for (const sub of subs) {
        const unsent = sanitizePostings(postingsByCompany.get(sub.company_slug) || []).filter(
          (p) => !sentSet.has(`${sub.user_id}:${p.id}`),
        );
        if (unsent.length) pending.push({ sub, unsent });
      }

      const authCache = new Map(); // user_id -> Promise<{email}|null>
      const getAuthUser = (userId) => {
        if (!authCache.has(userId)) {
          authCache.set(
            userId,
            (async () => {
              try {
                const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
                if (error || !data?.user?.email) return null;
                return { email: data.user.email };
              } catch (e) {
                console.error("[company-subs] getUserById failed:", redact((e && e.message) || String(e)));
                return null;
              }
            })(),
          );
        }
        return authCache.get(userId);
      };
      await mapWithConcurrency([...new Set(pending.map((x) => x.sub.user_id))], userConcurrency, getAuthUser);

      const wait = createThrottle(Math.ceil(1000 / Math.max(1, sendsPerSecond)), { sleep });
      for (const { sub, unsent } of pending) {
        const authUser = await getAuthUser(sub.user_id);
        if (!authUser) continue;
        const tpl = companyJobAlertEmail({
          companyName: sub.company_name,
          newJobs: [...unsent]
            .sort((a, b) => String(b.first_seen_at || "").localeCompare(String(a.first_seen_at || "")))
            .map((p) => ({ title: p.title, url: p.url, location: p.location, seniority: p.seniority })),
          companyUrl: `${appBaseUrl}/jobs/company/${encodeURIComponent(sub.company_slug)}`,
          manageUrl: `${appBaseUrl}/profile`,
        });
        const email = { to: authUser.email, tag: "company_job_alert", ...tpl };
        await wait();
        const result = await sendWithRetry(() => resend.sendEmail(email), { sleep });
        if (result && result.id) {
          stats.sent += 1;
          // Record immediately so a crash mid-run can't re-send this batch.
          const { error: recErr } = await supabaseAdmin
            .from("company_subscription_alerts_sent")
            .upsert(
              unsent.map((p) => ({ user_id: sub.user_id, job_posting_id: p.id })),
              { onConflict: "user_id,job_posting_id", ignoreDuplicates: true },
            );
          if (recErr) {
            console.error("[company-subs] failed to record sent alerts:", redact(recErr.message || String(recErr)));
          }
        } else {
          stats.failed += 1;
        }
      }
      if (pending.length) console.log("[company-subs] digest fan-out:", { sent: stats.sent, failed: stats.failed });
    } else {
      console.log("[company-subs] digest: no new postings for subscribed companies");
    }

    const pruneBefore = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const { error: pruneErr } = await supabaseAdmin
      .from("company_subscription_alerts_sent")
      .delete()
      .lt("sent_at", pruneBefore);
    if (pruneErr) {
      console.error("[company-subs] dedup-log prune failed:", redact(pruneErr.message || String(pruneErr)));
    }
  } catch (e) {
    status = "failed";
    console.error("[company-subs] digest failed", redact((e && e.message) || String(e)));
  } finally {
    // Failed runs are re-claimable (sql/29), done runs are not.
    const { error } = await supabaseAdmin.rpc("finish_digest_run", { p_run_date: runDate, p_status: status, p_stats: stats });
    if (error && !isMissingFn(error)) {
      console.error("[company-subs] finish_digest_run failed:", redact(error.message || String(error)));
    }
  }
}

/** Register the daily cron (09:00 India time) with an in-process overlap guard. */
export function scheduleCompanyDigest(cron, deps) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("[company-subs] job-alert digest disabled (no SUPABASE_SERVICE_ROLE_KEY)");
    return null;
  }
  let running = false;
  return cron.schedule(
    "0 9 * * *",
    async () => {
      if (running) return;
      running = true;
      try {
        await runCompanySubscriptionDigest(deps);
      } finally {
        running = false;
      }
    },
    { timezone: "Asia/Kolkata" },
  );
}

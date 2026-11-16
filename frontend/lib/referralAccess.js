/**
 * Pure rules for the referral feature (no I/O) so they can be unit tested.
 *
 * Work-email verification is OPTIONAL: it earns a "Verified" badge and a higher
 * accept limit, it never gates the feature. The original hole (anyone typing
 * company='Google' and downloading every requester's resume) is closed because
 * a resume is only ever served to the requester and to the single user who
 * accepted that request.
 */

export const ACCEPT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ACCEPT_LIMIT_UNVERIFIED = 3;
export const ACCEPT_LIMIT_VERIFIED = 20;
export const FANOUT_MAX_RECIPIENTS = 50;

export function acceptLimitFor(verified) {
  return verified ? ACCEPT_LIMIT_VERIFIED : ACCEPT_LIMIT_UNVERIFIED;
}

/** ISO timestamp marking the start of the rolling accept window. */
export function acceptWindowStart(now = Date.now()) {
  return new Date(now - ACCEPT_WINDOW_MS).toISOString();
}

/**
 * Rolling 24h accept limit.
 * @param {{ verified: boolean, acceptedAt: Array<string|number|Date>, now?: number }} a
 * @returns {{ allowed: boolean, limit: number, used: number, retryAt: string|null }}
 */
export function evaluateAcceptLimit({ verified, acceptedAt, now = Date.now() }) {
  const limit = acceptLimitFor(verified);
  const cutoff = now - ACCEPT_WINDOW_MS;
  const inWindow = (acceptedAt || [])
    .map((t) => new Date(t).getTime())
    .filter((t) => Number.isFinite(t) && t > cutoff && t <= now + 60_000)
    .sort((x, y) => x - y);
  const used = inWindow.length;
  if (used < limit) return { allowed: true, limit, used, retryAt: null };
  // A slot frees when the (used - limit + 1)th oldest accept leaves the window.
  const freeing = inWindow[used - limit];
  return { allowed: false, limit, used, retryAt: new Date(freeing + ACCEPT_WINDOW_MS).toISOString() };
}

export function acceptLimitMessage({ limit, verified }) {
  return verified
    ? `You've reached today's limit of ${limit} accepted referral requests. Please try again later.`
    : `You've reached today's limit of ${limit} accepted referral requests. ` +
        `Verify your work email to raise it to ${ACCEPT_LIMIT_VERIFIED} per day, or try again later.`;
}

/**
 * Who may download a request's resume: the requester, or the one user who
 * accepted it. Never "everyone at the company", verified or not.
 */
export function canViewResume({ userId, posterUserId, acceptedByUserId, status }) {
  if (!userId) return false;
  if (posterUserId && posterUserId === userId) return true;
  return status === "accepted" && !!acceptedByUserId && acceptedByUserId === userId;
}

/**
 * Pick fan-out recipients: verified first (stable within each group), only
 * entries that have an email, capped.
 * @param {Array<{ email?: string|null, verified?: boolean }>} candidates
 */
export function selectRecipients(candidates, cap = FANOUT_MAX_RECIPIENTS) {
  const withEmail = (candidates || []).filter((c) => c && c.email);
  const verified = withEmail.filter((c) => c.verified);
  const rest = withEmail.filter((c) => !c.verified);
  return [...verified, ...rest].slice(0, cap);
}

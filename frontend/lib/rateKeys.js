/**
 * Rate-limit key + limiter factories.
 *
 * Authenticated requests are keyed by user id (so one account behind a shared
 * NAT/VPN does not starve others, and one user cannot dodge limits by rotating
 * IPs). Unauthenticated requests fall back to the client IP (IPv6-safe).
 *
 * `req.user` is only populated by requireAuth/optionalAuth (verified token).
 * Limiters mounted BEFORE requireAuth therefore see no user and key on IP only;
 * mount user-keyed limiters AFTER requireAuth. Never key on unverified token
 * contents (a forged JWT `sub` would get a fresh bucket).
 */
import { rateLimit, ipKeyGenerator } from "express-rate-limit";

export function userOrIpKey(req) {
  if (req.user && req.user.id) return `u:${req.user.id}`;
  return `ip:${ipKeyGenerator(req.ip || "")}`;
}

/**
 * Pre-auth key: client IP ONLY. Anything derived from the Authorization header
 * before it is verified (JWT `sub`, token digest) is attacker-controlled - a
 * forged/rotated token would mint a fresh bucket per request and bypass the
 * limit entirely. Kept under the old name so existing call sites stay valid.
 * Once requireAuth has populated req.user (verified), key on the user id.
 */
export function ipKey(req) {
  return `ip:${ipKeyGenerator(req.ip || "")}`;
}

export function tokenOrIpKey(req) {
  if (req.user && req.user.id) return `u:${req.user.id}`;
  return ipKey(req);
}

/** Build a limiter with the project's standard options. */
export function makeLimiter({ windowMs, max, keyGenerator = userOrIpKey, message }) {
  return rateLimit({
    windowMs,
    max,
    keyGenerator,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { keyGeneratorIpFallback: false },
    message: message || { error: "Too many requests - slow down." },
  });
}

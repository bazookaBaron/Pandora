/**
 * Rate-limit key + limiter factories.
 *
 * Authenticated requests are keyed by user id (so one account behind a shared
 * NAT/VPN does not starve others, and one user cannot dodge limits by rotating
 * IPs). Unauthenticated requests fall back to the client IP (IPv6-safe).
 *
 * `req.user` is only populated by requireAuth/optionalAuth, which run AFTER
 * app-level limiters; so for the global limiter we peek at the Authorization
 * header and use a short digest of it as the key (the token itself is verified
 * later - this is purely a bucketing hint, never an auth decision).
 */
import crypto from "node:crypto";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";

export function userOrIpKey(req) {
  if (req.user && req.user.id) return `u:${req.user.id}`;
  return `ip:${ipKeyGenerator(req.ip || "")}`;
}

/** Bucket by bearer-token digest when present (global limiter, pre-auth). */
export function tokenOrIpKey(req) {
  if (req.user && req.user.id) return `u:${req.user.id}`;
  const h = req.headers && req.headers.authorization;
  if (h && /^Bearer\s+\S+/i.test(h)) {
    // Use the JWT `sub` claim without verifying (hint only); fall back to a digest.
    const tok = String(h).replace(/^Bearer\s+/i, "").trim();
    try {
      const payload = JSON.parse(
        Buffer.from(tok.split(".")[1] || "", "base64url").toString("utf8"),
      );
      if (payload && typeof payload.sub === "string" && payload.sub.length < 64) {
        // A forged `sub` only lets a client share/dodge ITS OWN bucket plus IP
        // is still mixed in, so it cannot be used to exhaust another user.
        return `t:${payload.sub}:${ipKeyGenerator(req.ip || "")}`;
      }
    } catch {
      /* fall through */
    }
    return `d:${crypto.createHash("sha1").update(tok).digest("hex").slice(0, 16)}`;
  }
  return `ip:${ipKeyGenerator(req.ip || "")}`;
}

/** Build a limiter with the project's standard options. */
export function makeLimiter({ windowMs, max, keyGenerator = tokenOrIpKey, message }) {
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

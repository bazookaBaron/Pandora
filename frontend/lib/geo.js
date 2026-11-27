// ── IP -> country ────────────────────────────────────────────────────
// Preferred: a country header set by the edge (Cloudflare cf-ipcountry /
// Vercel x-vercel-ip-country). Those are only trustworthy when the app is
// reachable ONLY through that edge, so they are honoured only when
// TRUST_GEO_HEADERS=true (a client could otherwise spoof "IN" to get INR
// pricing). Fallback: geoip-lite, whose ~100MB database is loaded lazily on
// first use instead of at process start (saves boot time + RSS when headers
// are trusted).
//
// Returns null for anything unresolvable (private/loopback ranges).
let _geoip = null;
async function geoip() {
  if (!_geoip) _geoip = (await import("geoip-lite")).default;
  return _geoip;
}

export function countryFromHeaders(req) {
  if (!/^(1|true|yes|on)$/i.test(process.env.TRUST_GEO_HEADERS || "")) return null;
  const h = req && req.headers;
  if (!h) return null;
  const v = String(h["cf-ipcountry"] || h["x-vercel-ip-country"] || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) && v !== "XX" && v !== "T1" ? v : null;
}

export async function countryFromIp(ip) {
  if (!ip) return null;
  try {
    const g = await geoip();
    const geo = g.lookup(ip);
    return geo?.country || null;
  } catch {
    return null;
  }
}

/** Header first (if trusted), then IP lookup. */
export async function countryFromRequest(req) {
  return (await detectCountry(req)).country;
}

/**
 * Like countryFromRequest but also says WHERE the answer came from:
 *   { country, source: 'header' | 'ip' | null }
 * 'header' (Cloudflare cf-ipcountry, only when TRUST_GEO_HEADERS=true) is the
 * reliable source; 'ip' (geoip-lite on req.ip) is best-effort and is what we
 * re-detect on later logins (profiles.country_source).
 *
 * PRODUCTION: behind Cloudflare, TRUST_GEO_HEADERS MUST be true, otherwise the
 * app only sees Cloudflare edge IPs (or a mis-counted proxy hop) and Indian
 * users get a wrong country, so INR flashes to USD.
 */
export async function detectCountry(req) {
  const fromHeader = countryFromHeaders(req);
  if (fromHeader) return { country: fromHeader, source: "header" };
  const fromIp = await countryFromIp(req && req.ip);
  return fromIp ? { country: fromIp, source: "ip" } : { country: null, source: null };
}

/**
 * Express "trust proxy" hop count from TRUST_PROXY_HOPS.
 *   Railway edge only            -> 1 (default)
 *   Cloudflare -> Railway edge   -> 2
 *   no proxy (local dev)         -> 0
 * Wrong values make req.ip a proxy address (or a spoofable client value), which
 * silently breaks geo-IP and rate limiting.
 */
export function trustProxyHops(env = process.env) {
  const raw = String(env.TRUST_PROXY_HOPS ?? "").trim();
  if (raw === "") return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 1;
}

/**
 * Should a stored country be re-detected on login? Never for a user-chosen
 * value; always when it came from IP detection (or predates country_source).
 */
export function shouldRedetectCountry(row) {
  if (!row || !row.country) return true;
  return row.country_source !== "user";
}

// India (and unknown) pays in INR; everyone else pays in USD. Unknown must
// NEVER resolve to USD - an existing Indian user whose country hasn't been
// detected yet could have a domestic-only card that can't settle a USD
// charge at all, turning a currency mismatch into a broken payment.
export function currencyForCountry(country) {
  return country && country !== "IN" ? "USD" : "INR";
}

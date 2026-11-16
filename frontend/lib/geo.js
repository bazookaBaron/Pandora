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
  return countryFromHeaders(req) || (await countryFromIp(req && req.ip));
}

// India (and unknown) pays in INR; everyone else pays in USD. Unknown must
// NEVER resolve to USD - an existing Indian user whose country hasn't been
// detected yet could have a domestic-only card that can't settle a USD
// charge at all, turning a currency mismatch into a broken payment.
export function currencyForCountry(country) {
  return country && country !== "IN" ? "USD" : "INR";
}

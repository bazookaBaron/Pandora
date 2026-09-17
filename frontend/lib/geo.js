import geoip from "geoip-lite";

// ── IP -> country (offline, free) ────────────────────────────────────
// geoip-lite bundles a MaxMind GeoLite country database and does the lookup
// fully in-process — no third-party API call, no rate limit, no per-request
// cost. Country-level IP block assignments change rarely, so the bundled
// snapshot staying slightly behind `npm update geoip-lite` is a minor,
// low-risk staleness, not a functional problem.
//
// Returns null for anything unresolvable (private/loopback ranges — always
// true in local dev; never in production, where `trust proxy` is set and
// Railway always presents a real public client IP via X-Forwarded-For).
export function countryFromIp(ip) {
  if (!ip) return null;
  try {
    const geo = geoip.lookup(ip);
    return geo?.country || null;
  } catch {
    return null;
  }
}

// India (and unknown) pays in INR; everyone else pays in USD. Unknown must
// NEVER resolve to USD — an existing Indian user whose country hasn't been
// detected yet could have a domestic-only card that can't settle a USD
// charge at all, turning a currency mismatch into a broken payment.
export function currencyForCountry(country) {
  return country && country !== "IN" ? "USD" : "INR";
}

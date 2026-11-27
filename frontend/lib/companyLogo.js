// Company logo/domain fields from a crawler.company row (logo_url, icon_url, domain).
// Pure helpers so they can be unit-tested without the server.

const clean = (v) => (typeof v === "string" ? v.trim() : "");

// Only http(s) absolute URLs are surfaced to the client (rendered as <img src>).
export function safeHttpUrl(v) {
  const s = clean(v);
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : "";
}

export function companyLogoFields(meta) {
  const m = meta || {};
  return {
    companyLogo: safeHttpUrl(m.logo_url) || safeHttpUrl(m.icon_url) || "",
    companyDomain: clean(m.domain).toLowerCase(),
  };
}

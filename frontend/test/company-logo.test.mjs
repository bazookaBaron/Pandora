import test from "node:test";
import assert from "node:assert/strict";
import { companyLogoFields, safeHttpUrl } from "../lib/companyLogo.js";
import { logoSources, lookupMappedDomain } from "../src/lib/companyLogo.js";

test("server: companyLogo prefers logo_url, then icon_url; domain lowercased", () => {
  assert.deepEqual(companyLogoFields({ logo_url: "https://a/l.svg", icon_url: "https://a/i.webp", domain: "Acme.com" }),
    { companyLogo: "https://a/l.svg", companyDomain: "acme.com" });
  assert.equal(companyLogoFields({ icon_url: "https://a/i.webp" }).companyLogo, "https://a/i.webp");
  assert.deepEqual(companyLogoFields(undefined), { companyLogo: "", companyDomain: "" });
});

test("server: non-http logo urls are dropped", () => {
  assert.equal(safeHttpUrl("javascript:alert(1)"), "");
  assert.equal(companyLogoFields({ logo_url: "data:image/png;base64,xx", icon_url: "https://a/i.png" }).companyLogo, "https://a/i.png");
});

test("client: domain map lookup is case-insensitive and works by slug", () => {
  assert.equal(lookupMappedDomain("google", null), "google.com");
  assert.equal(lookupMappedDomain("GOOGLE", null), "google.com");
  assert.equal(lookupMappedDomain("whatever", "google"), "google.com");
  assert.equal(lookupMappedDomain("Nope Corp 123", "nope-corp-123"), null);
});

test("client: source order logo -> companyDomain favicon -> static map", () => {
  const s = logoSources({ logo: "https://cdn/x.svg", domain: "foo.com", name: "Google" });
  assert.equal(s.length, 3);
  assert.equal(s[0], "https://cdn/x.svg");
  assert.match(s[1], /domain_url=foo\.com$/);
  assert.match(s[2], /domain_url=google\.com$/);
  assert.deepEqual(logoSources({ name: "Nope Corp 123" }), []);       // -> letter tile
  assert.equal(logoSources({ domain: "google.com", name: "Google" }).length, 1); // de-duplicated
  assert.equal(logoSources({ logo: "javascript:x" }).length, 0);
});

/**
 * Smoke tests for lib/seoHead.js's route classification, evidence gate, and
 * JSON-LD output. Pure functions, no server/DB — fast, no network.
 *
 * Run:  node test/seo-routes.test.mjs
 * Exit: 0 = pass, 1 = fail.
 */
import {
  buildHeadTags,
  classifyRoute,
  evaluateJobHubIndexability,
} from "../lib/seoHead.js";

const BASE = "https://www.vloombox.in";
let failures = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures += 1;
    console.error(`FAIL — ${label}\n  expected: ${e}\n  actual:   ${a}`);
  } else {
    console.log(`ok — ${label}`);
  }
}

function ok(label, cond) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL — ${label}`);
  } else {
    console.log(`ok — ${label}`);
  }
}

// ── classifyRoute ────────────────────────────────────────────────
check("jobs board is public + indexable", classifyRoute("/"), { kind: "public", key: "jobs" });
check("dsa list is public + indexable", classifyRoute("/dsa"), { kind: "public", key: "dsaList" });
check("dsa company page resolves the slug", classifyRoute("/dsa/company/google"), { kind: "public", key: "dsaCompany", slug: "google" });
check("lld problem page resolves the slug", classifyRoute("/lld/rate-limiter"), { kind: "public", key: "lldProblem", slug: "rate-limiter" });
check("hld list is public + indexable", classifyRoute("/hld"), { kind: "public", key: "hldList" });
check("hld workspace stays noindex (session state, not evergreen content)", classifyRoute("/hld/42"), { kind: "noindex" });
check("jobs company hub resolves the slug", classifyRoute("/jobs/company/google"), { kind: "public", key: "jobsCompany", slug: "google" });
check("auth stays noindex", classifyRoute("/auth"), { kind: "noindex" });
check("referrals stays noindex", classifyRoute("/referrals"), { kind: "noindex" });
check("unknown route passes through unmodified", classifyRoute("/some/unknown/path"), { kind: "passthrough" });

// ── evaluateJobHubIndexability ───────────────────────────────────
const eligible = evaluateJobHubIndexability({
  recordCount: 25, completeRecordCount: 22, uniqueFactCount: 10,
  substantiveWordCount: 400, newestAgeDays: 1, curated: true,
});
ok("a curated company with real, fresh, varied postings is eligible", eligible.eligible === true);

const uncurated = evaluateJobHubIndexability({
  recordCount: 25, completeRecordCount: 22, uniqueFactCount: 10,
  substantiveWordCount: 400, newestAgeDays: 1, curated: false,
});
ok("the same evidence is NOT eligible outside the curated set", uncurated.eligible === false);

const thin = evaluateJobHubIndexability({
  recordCount: 2, completeRecordCount: 2, uniqueFactCount: 2,
  substantiveWordCount: 80, newestAgeDays: 1, curated: true,
});
ok("thin evidence is ineligible even when curated", thin.eligible === false);

// ── JSON-LD output ───────────────────────────────────────────────
const faqTags = buildHeadTags({ key: "faq", base: BASE, path: "/faq" });
ok("faq page emits FAQPage JSON-LD", faqTags.includes('"@type":"FAQPage"'));
ok("faq JSON-LD carries real question text", faqTags.includes("How do referrals work?"));

const jobsCompanyTags = buildHeadTags({ key: "jobsCompany", base: BASE, path: "/jobs/company/google", jobsCompany: { name: "Google", openCount: 12 } });
ok("jobs company hub emits CollectionPage JSON-LD", jobsCompanyTags.includes('"@type":"CollectionPage"'));

if (failures > 0) {
  console.error(`\nFAIL — ${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nPASS — all SEO route/schema assertions passed.");

# Vloombox SEO Status

**Last updated:** 2026-11-23  
**Site:** https://www.vloombox.in  
**Repo:** bazookaBaron/Pandora  
**Rule:** This branch (`seo/tracker`) is tracking-only. Never merge into `main`.

## Phase
- **Completed:** Phase 1 foundation (name removal, AI bots in robots.txt, llms.txt, CollectionPage + FAQPage schema, H1/copy cleanups).
- **Current:** Daily automation. Explicit AI-bot allows confirmed live. Focus on JobPosting accuracy, sitemap lastmod, content clusters.

## Live health (2026-11-12)
| Check | Status |
|--------|--------|
| robots.txt | Live with explicit allows for OAI-SearchBot, Claude-SearchBot, PerplexityBot, GPTBot, Google-Extended, etc. Private paths disallowed. Sitemap linked. |
| /llms.txt | Present, accurate entity definition + primary pages. |
| Personal name on legal/about | Not detected (about page clean). |
| Schema | CollectionPage / FAQPage present per prior; homepage title still hardcodes ~14k. |
| Sitemap | Large (core + company + DSA pages), no lastmod observed. |
| Brand pollution | Confirmed: weekday.works, foundit list jobs "at Vloombox" (employer misattribution). |

## Active priorities
1. Merge PR #12 (pageviews), then read 7d of real traffic. JobPosting: no public job-detail pages exist; revisit only if per-job pages are added.
2. Sitemap lastmod discipline + IndexNow consideration.
3. Internal link graph + topic cluster outlines (DSA, system design, resume, referrals, trends).
4. GEO Q&A blocks + entity clarity.
5. Title/H1 alignment (dynamic job count).

## Latest run (2026-11-23)
- GSC export 11-12..11-20: 9 days, 80 impressions / 1 click (dsa/company page, mobile India). Still company-name queries; nothing actionable. PostHog $pageview still absent (14d). Inbox quiet. No PR, blog or outreach. Open PRs #14, #9 not mine.

## Previous run (2026-11-22)
- GSC export 11-12..11-19: 8 days, 63 impressions / 0 clicks, company-name queries only. PostHog $pageview still absent (14d). Inbox quiet. No PR, blog or outreach. Open PRs #14, #9 not mine.

## Previous run (2026-11-21)
- GSC export 11-12..11-18: 7 days, ~59 impressions / 0 clicks, company-name queries only. PostHog $pageview still absent. Inbox quiet. No PR, blog or outreach. Open PRs #14, #9 not mine.

## Previous run (2026-11-20)
- GSC export 11-12..11-17: 6 days, ~56 impressions / 0 clicks, company-name queries only; nothing actionable. PostHog $pageview still absent. Inbox quiet. No PR, blog or outreach. Open PRs #14, #9 not mine.

## Previous run (2026-11-19)
- GSC export 11-12..11-16: 5 days, 44 impressions / 0 clicks total; still company-name queries (hcltech jobs page most impressions, avg pos 6-35; dsa/company pages pos 3-30). No query x page pair with enough volume to act on. PostHog $pageview still absent (6+ days post PR #12 merged; confirm VITE_POSTHOG_KEY on Railway). Live fetch tool unavailable this run. No PR, blog or outreach (personal mailbox blocker unchanged). Open PRs #14, #9 not mine.

## Previous run (2026-11-18)
- GSC export 11-12..11-15: 33 impressions / 0 clicks, company-name queries only. PostHog $pageview still absent (12 days post PR #12). No PR, blog or outreach. Open PRs #14, #9 not mine.

## Previous run (2026-11-17)
- GSC export: 24 impressions / 0 clicks over 11-12..11-14 (company-name queries only). PostHog $pageview still absent (6 days post PR #12; check VITE_POSTHOG_KEY). No PR, blog or outreach. Open PRs #14, #9 not mine.

## Previous run (2026-11-16)
- GSC export first data (11-12..13): about 13 impressions, 0 clicks, on /jobs/company/hcltech, /jobs/company/nvidia, /dsa/company/trilogy for company-name queries. Too thin to act on. PostHog $pageview still absent 3 days after PR #12 (check VITE_POSTHOG_KEY on Railway). No PR, blog or outreach (personal mailbox blocker unchanged).

## Previous run (2026-11-15)
- GSC export tables now exist but have 0 rows; PostHog still no $pageview; no PR, blog or outreach this run (no data to drive them). Jobs snapshot 13,986 on 11-14 (closed_postings always 0; do not publish counts).

## Previous run (2026-11-14)
- PR #13 merged (squash, CI green): homepage title no longer hardcodes a job count. GSC export dataset still has zero tables (empty list). PostHog `$pageview` still not seen in 30d. Jobs snapshot is volatile: 5,117 (11-09) -> 13,988 (11-10) -> 13,930 (11-11) -> 3,838 (11-12) -> 13,534 (11-13); crawl/ingestion instability, so no stats in public content. Brand SERP check: vloombox.in not in top 10 for its own name. No blog, 0 outreach (personal mailbox; no replies/support mail).

## Previous run (2026-11-13 run 2)
- PR #13 open, CI green, merge blocked by permissions (homepage title no longer hardcodes 14,000+). GSC export tables not present yet; PostHog has no $pageview yet. Jobs snapshot dropped 13,930 -> 3,838 on 11-12 (investigate). Blog and outreach skipped (see history).

## Last actions (2026-11-13)
- Found PostHog `$pageview` = 0 for 30d (capture_pageview:false, helper unused). Opened PR #12 to fix. Awaiting review/merge; also confirm VITE_POSTHOG_KEY is set in Railway.
- Reclassified JobPosting item: no public job-detail route exists.
- No SERP visibility change; no personal-name leak.

## Previous actions (2026-11-12)
- Live state check: robots/llms/sitemap/about healthy.
- SERP spot-checks: no strong organic for priority non-brand terms; brand pollution persists.
- PostHog: prior quiet signal; no new traffic data this run.
- Tracker refresh only (monitoring day).

## Next actions
- Sketch safe JobPosting JSON-LD addition (hiringOrganization from real company data).
- Add lastmod to sitemap generation if low-risk.
- Content cluster outlines in backlog.

## Blockers
- Gmail connector is a personal mailbox: outreach paused until a Vloombox mailbox is connected.
- No GSC private key (rely on live fetches + public SERP + PostHog).
- PostHog traffic baseline unavailable until PR #12 ships (and VITE_POSTHOG_KEY is confirmed set).
- Brand pollution requires accurate schema + possible content disambiguation; third-party control limited.

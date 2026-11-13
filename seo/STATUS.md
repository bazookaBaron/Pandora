# Vloombox SEO Status

**Last updated:** 2026-11-13 (run 2)  
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

## Latest run (2026-11-13 run 2)
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

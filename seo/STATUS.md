# Vloombox SEO Status

**Last updated:** 2026-11-12 (daily run)  
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
1. JobPosting schema with hiringOrganization = real employer on job details (anti-pollution).
2. Sitemap lastmod discipline + IndexNow consideration.
3. Internal link graph + topic cluster outlines (DSA, system design, resume, referrals, trends).
4. GEO Q&A blocks + entity clarity.
5. Title/H1 alignment (dynamic job count).

## Last actions
- Live state check: robots/llms/sitemap/about healthy.
- SERP spot-checks: no strong organic for priority non-brand terms; brand pollution persists.
- PostHog: prior quiet signal; no new traffic data this run.
- Tracker refresh only (monitoring day).

## Next actions
- Sketch safe JobPosting JSON-LD addition (hiringOrganization from real company data).
- Add lastmod to sitemap generation if low-risk.
- Content cluster outlines in backlog.

## Blockers
- No GSC private key (rely on live fetches + public SERP + PostHog).
- PostHog traffic signals limited (quiet project).
- Brand pollution requires accurate schema + possible content disambiguation; third-party control limited.

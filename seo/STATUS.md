# Vloombox SEO Status

**Last updated:** 2026-11-11 (daily run)  
**Site:** https://www.vloombox.in  
**Repo:** bazookaBaron/Pandora  
**Rule:** This branch (`seo/tracker`) is tracking-only. Never merge into `main`.

## Phase
- **Completed:** Phase 1 foundation (name removal, basic AI bots claim, llms.txt, CollectionPage + FAQPage schema, H1/copy).
- **Current:** Daily automation active. Explicit AI-bot robots + homepage entity schema + richer llms.txt shipped to branch (PR form pending).

## Live health (2026-11-11)
| Check | Status |
|--------|--------|
| robots.txt | Live matches code: User-agent: * Allow public / Disallow private. No explicit AI-bot blocks yet (PR addresses). |
| /llms.txt | Present, basic. PR expands entity definition. |
| Personal name on legal/about | Not detected in fetches (SPA; assume Phase 1 hold). |
| Schema | CollectionPage on jobs/dsa/etc.; FAQPage on /faq; WebSite+Organization currently on /optimizer (home key). Jobs homepage PR adds them. |
| Sitemap | Static + company pages, no lastmod. |
| Brand pollution | Confirmed: third-party boards list jobs "at Vloombox". |

## Active priorities
1. Merge PR for AI bots + homepage schema + llms.txt
2. JobPosting schema accuracy (hiringOrganization = real employer) on /jobs/:id
3. Sitemap lastmod + IndexNow
4. Internal link graph + topic clusters
5. GEO Q&A blocks
6. Brand-SERP pollution monitoring / disambiguation

## Last actions
- Live state check completed.
- Pushed branch `seo/ai-bots-and-homepage-schema` with 3 safe changes.
- PR creation form rendered (awaiting submit).
- PostHog: no recent events (project quiet or instrumentation gap).
- SERP: brand pollution observed; no strong organic for priority non-brand terms in spot check.

## Next actions
- Confirm PR created and CI green; merge if safe.
- Next run: JobPosting schema sketch + lastmod on sitemap.

## Blockers
- GSC private key unavailable (use PostHog + live + public SERP).
- PostHog shows zero events in last 30d — traffic signals limited.

# SEO Backlog (prioritized)

Never merge this file via `seo/tracker` → main. Implementation PRs go to `main` separately.

## P0 — Indexation & trust
- [x] Verify production robots/sitemap/llms after Phase 1 deploy
- [x] Explicit AI search bot allows in robots.txt (confirmed live 2026-11-12)
- [ ] JobPosting `hiringOrganization` = real employer -- BLOCKED: no public job-detail route exists (/jobs -> /). Only relevant if per-job pages are added; otherwise handle pollution via disambiguation copy.
- [x] PR #12: PostHog SPA pageviews (merged; verify events arrive) -- prerequisite for any traffic-based decision
- [x] CollectionPage patterns for jobs list (present)
- [x] FAQPage schema on `/faq` (present)
- [x] Homepage WebSite + Organization schema (live)

## P1 — On-page & internal graph
- [x] Homepage title no longer hardcodes job count (PR #13)
- [ ] Investigate jobs snapshot drop 13,930 -> 3,838 (2026-11-12)
- [ ] Title/H1/meta alignment audit on other templates
- [ ] Internal links between jobs, trends, blog, FAQ, interview topics
- [ ] BreadcrumbList on more nested routes

## P2 — Content clusters (GEO + classic)
- [ ] Pillar: system design interview practice
- [ ] Pillar: AI resume / ATS optimizer
- [ ] Pillar: referral board how-to
- [ ] Pillar: tech jobs India (with trends data)
- [ ] Supporting posts per cluster; Article schema

## P3 — AI search / agentic
- [x] Keep llms.txt in sync
- [x] Explicit entity definition blocks for "Vloombox"
- [ ] Q&A blocks optimized for AI Overviews / citations on key pages

## P4 — Performance & ops
- [ ] `/jobs` LCP review
- [ ] IndexNow on meaningful URL changes
- [ ] Sitemap lastmod accuracy: only blog + /lld/* carry it; /dsa/company/* (323) and /jobs/company/* lack it. Needs a real updated_at source before adding.

## Done
- [x] Remove personal name from legal/about
- [x] Basic AI crawler allow (User-agent: *)
- [x] llms.txt foundation
- [x] Basic CollectionPage + FAQPage schema
- [x] Daily automation + tracker branch
- [x] Explicit AI-bot robots.txt (live)

# SEO Backlog (prioritized)

Never merge this file via `seo/tracker` → main. Implementation PRs go to `main` separately.

## P0 — Indexation & trust
- [x] Verify production robots/sitemap/llms after Phase 1 deploy
- [x] Explicit AI search bot allows in robots.txt (confirmed live 2026-11-12)
- [ ] JobPosting `hiringOrganization` = real employer (not Vloombox) on job detail pages — anti brand pollution
- [x] CollectionPage patterns for jobs list (present)
- [x] FAQPage schema on `/faq` (present)
- [x] Homepage WebSite + Organization schema (live)

## P1 — On-page & internal graph
- [ ] Title/H1/meta alignment audit on top templates (jobs title still hardcodes 14,000+ in places)
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
- [ ] Sitemap lastmod accuracy

## Done
- [x] Remove personal name from legal/about
- [x] Basic AI crawler allow (User-agent: *)
- [x] llms.txt foundation
- [x] Basic CollectionPage + FAQPage schema
- [x] Daily automation + tracker branch
- [x] Explicit AI-bot robots.txt (live)

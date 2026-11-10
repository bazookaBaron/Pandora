# SEO Backlog (prioritized)

Never merge this file via `seo/tracker` → main. Implementation PRs go to `main` separately.

## P0 — Indexation & trust
- [ ] Verify production robots/sitemap/llms after Phase 1 deploy
- [ ] JobPosting `hiringOrganization` = real employer (not Vloombox)
- [ ] CollectionPage + ItemList patterns for jobs list
- [ ] FAQPage schema on `/faq`

## P1 — On-page & internal graph
- [ ] Title/H1/meta alignment audit on top templates
- [ ] Internal links between jobs, trends, blog, FAQ, interview topics
- [ ] BreadcrumbList on nested routes

## P2 — Content clusters (GEO + classic)
- [ ] Pillar: system design interview practice
- [ ] Pillar: AI resume / ATS optimizer
- [ ] Pillar: referral board how-to
- [ ] Pillar: tech jobs India (with trends data)
- [ ] Supporting posts per cluster; Article schema

## P3 — AI search / agentic
- [ ] Keep llms.txt in sync with product surface area
- [ ] Explicit entity definition blocks for "Vloombox"
- [ ] Q&A blocks optimized for AI Overviews / citations

## P4 — Performance & ops
- [ ] `/jobs` LCP review
- [ ] IndexNow on meaningful URL changes
- [ ] Sitemap lastmod accuracy

## Done
- [x] Remove personal name from legal/about
- [x] AI crawler allow rules
- [x] llms.txt foundation
- [x] Basic WebSite + Organization schema (jobs)
- [x] Daily automation + tracker branch

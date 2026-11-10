# Vloombox SEO Status

**Last updated:** 2026-11-11  
**Site:** https://www.vloombox.in  
**Repo:** bazookaBaron/Pandora  
**Rule:** This branch (`seo/tracker`) is tracking-only. Never merge into `main`.

## Phase
- **Completed:** Phase 1 foundation (personal name removal from legal/about, AI search bots in robots.txt, `llms.txt`, WebSite+Organization schema on jobs route, H1/copy alignment, StaticPages restore).
- **Current:** Daily automation active (`vloombox-seo-daily`, 08:30 Asia/Kolkata).

## Live health (seed)
| Check | Target |
|--------|--------|
| robots.txt AI bots | Allow OAI-SearchBot, Claude-SearchBot, PerplexityBot |
| /llms.txt | Present + accurate site description |
| Personal name on legal/about | Absent |
| Job hub indexability gate | Intact |
| Schema | Expand JobPosting accuracy, FAQPage, Article |

## Active priorities
1. JobPosting + CollectionPage completeness for `/jobs`
2. FAQPage JSON-LD on `/faq` (export `FAQPage` matches router)
3. Blog/trends Article schema + topic cluster plan
4. IndexNow + sitemap `lastmod` discipline
5. Internal links: jobs ↔ blog ↔ FAQ ↔ trends ↔ interview
6. GEO citability (definitions, Q&A blocks, entity clarity)
7. `/jobs` LCP awareness
8. Brand-SERP pollution monitoring

## Last actions
- Phase 1 PR merged to main.
- Daily automation created.
- Tracker branch bootstrapped.

## Next actions (for next automation run)
- Live fetch robots/sitemap/llms/homepage/jobs/faq/about
- PostHog top pages (7d)
- SERP spot-check priority keywords
- Ship ≤3 safe PR actions or monitoring-only entry

## Blockers
- GSC service-account private key not available to the agent (use PostHog + live site + public SERP instead).

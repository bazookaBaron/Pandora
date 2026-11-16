# Jobs data lives in the job-crawler repo — NOT here

The `crawler` schema is **owned by a separate repository**, the job crawler:

- GitHub: `bazookaBaron/JobCrawler`
- Schema/migrations: `crawler/src/pgpipe/` (schema.sql + migrations)

The Vloombox app only *reads* it (via Supabase / PostgREST, schema `crawler`
must be in "Exposed schemas"). **Do not add `crawler.*` tables or indexes in
this `sql/` directory.** The one exception is the thin read-side helpers in
`29_jobs_feed_reader.sql` (functions only — no tables in `crawler`).

## How the jobs API reads data now

The old approach (fetch a 600-row pool of `job_posting`, interleave by company
in Node, count by estimate) is gone. The crawler pre-computes the feed:

| Object (crawler repo) | Used by |
|---|---|
| `crawler.job_feed` (table, rebuilt by `crawler.build_feed()` after every crawl; open, non-duplicate rows from the last 24h, ordered by a company-cooldown `feed_position`) | `GET /api/jobs` default view (`ORDER BY feed_position`, exact count), company hub, sitemap/curated slugs, analytics |
| `crawler.feed_page(p_q, p_company, p_location, p_location_type, p_seniority, p_source, p_country, p_company_type, p_hours, p_offset, p_limit)` | `GET /api/jobs` when any filter is set (re-applies the company cooldown over the filtered set, returns `total_count`) |
| `crawler.job_posting.duplicate_of / eff_at / apply_url / alt_urls / company_name` | job-alert digest (excludes duplicates), response fields |

`p_location` receives several locations as one `'|'`-separated string.

## What `29_jobs_feed_reader.sql` adds (this repo)

`crawler.company_job_counts`, `crawler.job_feed_facet`, `crawler.job_feed_sources`,
`crawler.jobs_feed_analytics` (all service_role-only) and the `digest_runs`
table + `claim_digest_run` / `finish_digest_run` for the daily alert digest.
Run order: crawler migration first, then `18_company_subscriptions.sql`
(re-run; it replaces `company_subscription_new_postings`), then `29`.

## Indexes the crawler repo should have

All on `crawler.job_feed` (small, fully rebuilt each crawl — create them in the
build function / migration so a rebuild keeps them):

| Index | Query it serves |
|-------|-----------------|
| unique `(feed_position)` | default feed `ORDER BY feed_position` + `range()` |
| `(id)` | joins / lookups by posting id |
| `(country)`, `(seniority)`, `(source)` | filter pushdown in `feed_page` and the direct sort paths |
| `(company_slug)` | company hub (`WHERE company_slug = $1 ORDER BY eff_at DESC`), `company_job_counts` |
| `pg_trgm` GIN on `title`, `company_name`, `location` | free-text search, company/location filters, `job_feed_facet` (needs `CREATE EXTENSION IF NOT EXISTS pg_trgm`) |

On `crawler.job_posting`: partial unique `(linkedin_job_id) WHERE linkedin_job_id IS NOT NULL`,
`(dedupe_key)`, and `(status, first_seen_at) WHERE status = 'open' AND duplicate_of IS NULL`
for the digest function.

Apply with `CREATE INDEX CONCURRENTLY IF NOT EXISTS` on the live DB, one
statement at a time (CONCURRENTLY cannot run inside a transaction block).

## Caching in the API

| Data | TTL |
|---|---|
| `/api/jobs` response (keyed by plan + normalized query) | 45 s |
| Facet candidate lists per field / facet answers | 5 min |
| Curated company slugs (`company_job_counts`), sources | 10 min |
| Company hub payload, analytics, trend | 5 min |

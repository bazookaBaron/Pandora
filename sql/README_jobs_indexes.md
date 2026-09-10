# Jobs indexes belong in the job-crawler repo — NOT here

The `crawler.job_posting` and `crawler.company` tables are **owned by a separate
repository**, the job crawler:

- GitHub: `bazookaBaron/JobCrawler`
- Local path: `C:\Users\debna\Downloads\job-crawler`
- Schema file: `crawler/src/pgpipe/schema.sql`

That project owns the `crawler` schema, its migrations, and its DDL. The Vloombox
app only *reads* those tables (via Supabase / PostgREST) for the `/api/jobs/*`
routes. **Do not add `crawler.*` indexes in this `sql/` directory** — add them in
the crawler repo's `schema.sql` (and its migration path) so the two repos don't
fight over the same objects.

This file is just a checklist of what the crawler repo should have, based on the
query shapes the Vloombox `/api/jobs/*` routes issue.

## Recommended indexes (add in the crawler repo)

| Index | Query it serves |
|-------|-----------------|
| `job_posting (status, first_seen_at DESC, id DESC) WHERE status = 'open'` | Main listing: `WHERE status = 'open' ORDER BY first_seen_at DESC, id DESC` plus keyset/range pagination. Partial on `status = 'open'` keeps it small. |
| GIN on `job_posting.search_tsv` | `websearch_to_tsquery` full-text search (`search_tsv @@ ...`). **Confirm this already exists** in `schema.sql` — a tsvector column is usually created with its GIN index, but verify; without it every keyword search is a seq scan. |
| `pg_trgm` GIN on `job_posting.company_slug` | `company_slug ILIKE '%…%'` filter + `/api/jobs/facets` autocomplete. Needs `CREATE EXTENSION IF NOT EXISTS pg_trgm;` in the crawler DB. |
| `pg_trgm` GIN on `job_posting.location` | `location ILIKE '%…%'` filter + `/api/jobs/facets` autocomplete. |
| `pg_trgm` GIN on `job_posting.title` | `title ILIKE '%…%'` filter + `/api/jobs/facets` autocomplete. |
| `job_posting (status, source) WHERE status = 'open'` | The `source` facet aggregation over the open set. |

## Notes

- The listing endpoint also asks PostgREST for `count: "exact"` on the filtered
  set, which forces a full count scan per request. **Phase 0.4** will switch this
  to a planned/estimated count, which removes that cost — no index fixes it while
  it stays `exact`.
- There is also a `company WHERE slug IN (...)` lookup to hydrate company rows for
  a page of postings. `company.slug` is almost certainly the primary key (or has a
  unique index), so that lookup is already covered — verify in `schema.sql`, add
  nothing if the PK is there.
- All of the above should be `CREATE INDEX CONCURRENTLY IF NOT EXISTS` when applied
  to the live crawler DB, one statement at a time (CONCURRENTLY cannot run inside a
  transaction block).

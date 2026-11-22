-- 39_market_analytics_role_mix.sql
-- Pool mix: ~90% tech / ~10% product-associated roles, ~90% India / ~10% USA,
-- postings <= 15 days old. The JobCrawler classifies each title at ingest into
-- crawler.job_posting.role_family ('tech' | 'product'; non-tech corporate roles
-- are dropped) and role_category (finer chart label). This migration:
--   * adds those two columns (idempotent; the crawler's schema.sql adds them too),
--   * rewrites crawler.market_analytics(p_country) to chart role_category (no
--     Sales/Marketing/Finance/HR/... buckets), a tech-vs-product split, the
--     India-vs-USA split of the whole pool, and a 15-day window.
-- Only DDL on the crawler schema; no user data outside crawler.job_posting.
alter table crawler.job_posting add column if not exists role_family text;
alter table crawler.job_posting add column if not exists role_category text;
create index if not exists job_posting_role_family_idx
  on crawler.job_posting (role_family, country);

create or replace function crawler.market_analytics(p_country text)
returns json
language sql
stable
as $$
with pool as (   -- the whole stored pool in the 15-day window (both countries)
  select p.company_slug, p.country, p.role_family, p.role_category, p.seniority,
         coalesce(p.posted_at, p.first_seen_at) as posted
  from crawler.job_posting p
  where p.status = 'open'
    and p.country in ('IN','US')
    and p.role_family in ('tech','product')
    and coalesce(p.posted_at, p.first_seen_at) >= now() - interval '15 days'
),
j as (select * from pool where country = p_country),
tot as (select count(*)::int as open_now,
               count(*) filter (where posted >= now() - interval '24 hours')::int as new_24h,
               count(distinct company_slug)::int as companies from j),
fam as (select role_family as label, count(*)::int as n from j group by 1),
cat as (select role_category as label, role_family as family, count(*)::int as n
        from j where role_category is not null group by 1, 2),
mixc as (select country as label, count(*)::int as n from pool group by 1),
sen as (select coalesce(seniority, 'unknown') as label, count(*)::int as n from j group by 1),
top as (
  select coalesce(co.name, j.company_slug) as name, count(*)::int as n,
         coalesce(co.company_type, 'unknown') as type
  from j left join crawler.company co on co.slug = j.company_slug
  group by 1, 3 order by n desc, name limit 10
),
ctype as (
  select coalesce(co.company_type, 'unknown') as label, count(*)::int as n
  from j left join crawler.company co on co.slug = j.company_slug group by 1
)
select json_build_object(
  'window_days', 15,
  'open_now', (select open_now from tot),
  'new_24h', (select new_24h from tot),
  'companies', (select companies from tot),
  -- tech vs product split for the selected country
  'role_split', (select coalesce(json_agg(json_build_object('label', label, 'count', n) order by n desc), '[]'::json) from fam),
  -- category chart rows (tech + product categories only), each tagged with its family
  'families', (select coalesce(json_agg(json_build_object('label', label, 'family', family, 'count', n) order by n desc), '[]'::json) from cat),
  -- India vs USA across the whole pool (independent of p_country)
  'country_split', (select coalesce(json_agg(json_build_object('label', label, 'count', n) order by n desc), '[]'::json) from mixc),
  'seniority', (select coalesce(json_agg(json_build_object('label', label, 'count', n) order by n desc), '[]'::json) from sen),
  'top_companies', (select coalesce(json_agg(json_build_object('name', name, 'count', n, 'type', type) order by n desc, name), '[]'::json) from top),
  'company_types', (select coalesce(json_agg(json_build_object('label', label, 'count', n) order by n desc), '[]'::json) from ctype)
);
$$;

revoke all on function crawler.market_analytics(text) from public, anon, authenticated;
grant execute on function crawler.market_analytics(text) to service_role;

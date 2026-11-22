-- 37_market_analytics_rpc.sql
-- Market analytics straight from the crawler pool (no third-party data).
-- Called by GET /api/market/analytics via the service role. One round trip,
-- pure SQL aggregates over crawler.job_posting (status = 'open').
create or replace function crawler.market_analytics(p_country text)
returns json
language sql
stable
as $$
with j as (
  select p.company_slug, p.title, p.seniority,
         coalesce(p.posted_at, p.first_seen_at) as posted
  from crawler.job_posting p
  where p.status = 'open' and p.country = p_country
),
r as (
  select j.*,
    case
      when t ~ '(^|[^a-z])(sap|erp|oracle (fusion|ebs|apps|cloud)|netsuite|dynamics 365|workday (hcm|finance)|s/4)' then 'SAP / ERP'
      when t ~ '(machine learning|\mml\M|\mai\M|data scien|deep learning|\mllm\M|nlp|computer vision|data engineer|data analyst|analytics)' then 'Data / ML'
      when t ~ '(devops|\msre\M|site reliability|platform engineer|cloud engineer|infrastructure engineer|systems engineer|reliability engineer)' then 'DevOps / SRE'
      when t ~ '(\mqa\M|quality assurance|test engineer|sdet|test automation|quality engineer)' then 'QA'
      when t ~ '(security|cyber|infosec|penetration|\msoc\M)' then 'Security'
      when t ~ '(product manager|product owner|product management|head of product|\mcpo\M)' then 'Product'
      when t ~ '(designer|\mux\M|\mui\M|user experience|design lead|creative director)' then 'Design'
      when t ~ '(software|developer|engineer|programmer|backend|frontend|front-end|back-end|full.?stack|mobile|android|\mios\M|firmware|embedded|architect)' then 'Software engineering'
      when t ~ '(sales|account executive|business development|account manager|solutions consultant|customer success)' then 'Sales'
      when t ~ '(marketing|growth|\mseo\M|brand|content|communications|social media)' then 'Marketing'
      when t ~ '(financ|account(ant|ing)|audit|controller|treasury|tax|payroll|fp&a)' then 'Finance'
      when t ~ '(recruit|talent|human resources|\mhr\M|people (partner|operations|business)|hrbp)' then 'HR'
      when t ~ '(consultant|consulting|advisory|strategy)' then 'Consulting'
      when t ~ '(operations|supply chain|logistics|procurement|program manager|project manager|facilities|business analyst)' then 'Operations'
      else 'Other'
    end as family
  from (select j.*, lower(j.title) as t from j) j
),
tot as (select count(*)::int as open_now,
               count(*) filter (where posted >= now() - interval '24 hours')::int as new_24h,
               count(distinct company_slug)::int as companies from j),
fam as (select family as label, count(*)::int as n from r group by 1),
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
  'open_now', (select open_now from tot),
  'new_24h', (select new_24h from tot),
  'companies', (select companies from tot),
  'families', (select coalesce(json_agg(json_build_object('label', label, 'count', n) order by n desc), '[]'::json) from fam),
  'seniority', (select coalesce(json_agg(json_build_object('label', label, 'count', n) order by n desc), '[]'::json) from sen),
  'top_companies', (select coalesce(json_agg(json_build_object('name', name, 'count', n, 'type', type) order by n desc, name), '[]'::json) from top),
  'company_types', (select coalesce(json_agg(json_build_object('label', label, 'count', n) order by n desc), '[]'::json) from ctype)
);
$$;

revoke all on function crawler.market_analytics(text) from public, anon, authenticated;
grant execute on function crawler.market_analytics(text) to service_role;

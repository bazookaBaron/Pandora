-- ============================================================================
-- 29_jobs_feed_reader.sql — read-side helpers for the jobs feed API
-- (frontend/routes/jobs.js) + the digest cross-instance lock.
-- Idempotent. Run in the Supabase SQL Editor AFTER the crawler repo's
-- migration that creates crawler.job_feed / crawler.feed_page / the new
-- job_posting columns (apply_url, alt_urls, company_name, duplicate_of, eff_at).
--
-- Contents
--   crawler.company_job_counts(p_limit)      open postings per company (curated slugs / sitemap)
--   crawler.job_feed_facet(field, q, limit)  distinct values + counts for autocomplete
--   crawler.job_feed_sources()               distinct sources for the filter dropdown
--   crawler.jobs_feed_analytics()            aggregate metrics over the SAME window as the feed
--   public.digest_runs + claim/finish fns    one digest run per IST day across instances
--
-- All crawler.* functions are SECURITY INVOKER and only executable by
-- service_role (the API's server-side client); nothing is exposed to anon.
-- Note: the `crawler` schema must be in Supabase's "Exposed schemas" (already
-- required by the jobs API).
-- ============================================================================

-- ── company_job_counts ──────────────────────────────────────────────────────
-- PostgREST silently caps selects at 1000 rows, so counting slugs in JS from a
-- raw select undercounts. Aggregate in SQL instead.
CREATE OR REPLACE FUNCTION crawler.company_job_counts(p_limit int DEFAULT 200)
RETURNS TABLE (company_slug text, open_count bigint)
LANGUAGE sql STABLE SET search_path = crawler, public AS $$
  SELECT f.company_slug, count(*)::bigint AS open_count
  FROM crawler.job_feed f
  WHERE f.company_slug IS NOT NULL
  GROUP BY f.company_slug
  ORDER BY open_count DESC, f.company_slug
  LIMIT least(greatest(coalesce(p_limit, 200), 1), 5000)
$$;

-- ── job_feed_facet ──────────────────────────────────────────────────────────
-- Distinct values of one job_feed column with their counts. Empty q = the most
-- common values; otherwise prefix matches first, then substring, then trigram
-- (typo-tolerant) matches. Uses the trigram indexes on job_feed when present.
CREATE OR REPLACE FUNCTION crawler.job_feed_facet(p_field text, p_q text DEFAULT '', p_limit int DEFAULT 20)
RETURNS TABLE (value text, cnt bigint)
LANGUAGE plpgsql STABLE SET search_path = crawler, public, extensions AS $fn$
DECLARE
  q   text := btrim(coalesce(p_q, ''));
  pat text;
  lim int  := least(greatest(coalesce(p_limit, 20), 1), 1000);
BEGIN
  IF p_field NOT IN ('company_name', 'location', 'title') THEN
    RAISE EXCEPTION 'invalid facet field: %', p_field USING ERRCODE = '22023';
  END IF;
  -- escape LIKE metacharacters in the user text
  pat := replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_');

  RETURN QUERY EXECUTE format($q$
    SELECT s.v AS value, count(*)::bigint AS cnt
    FROM (SELECT %1$I AS v FROM crawler.job_feed WHERE %1$I IS NOT NULL AND %1$I <> '') s
    WHERE $1 = ''
       OR s.v ILIKE $2 || '%%'
       OR s.v ILIKE '%%' || $2 || '%%'
       OR (length($1) >= 3 AND similarity(s.v, $1) > 0.35)
    GROUP BY s.v
    ORDER BY
      CASE WHEN $1 = '' OR s.v ILIKE $2 || '%%' THEN 0
           WHEN s.v ILIKE '%%' || $2 || '%%' THEN 1 ELSE 2 END,
      count(*) DESC, s.v
    LIMIT $3
  $q$, p_field) USING q, pat, lim;
END
$fn$;

-- ── job_feed_sources ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION crawler.job_feed_sources()
RETURNS TABLE (source text, cnt bigint)
LANGUAGE sql STABLE SET search_path = crawler, public AS $$
  SELECT f.source, count(*)::bigint
  FROM crawler.job_feed f
  WHERE f.source IS NOT NULL
  GROUP BY f.source
  ORDER BY 2 DESC, 1
$$;

-- ── jobs_feed_analytics ─────────────────────────────────────────────────────
-- Same JSON shape the old crawler.jobs_analytics() returned, but computed over
-- crawler.job_feed so the Analytics tab counts exactly what the feed shows.
CREATE OR REPLACE FUNCTION crawler.jobs_feed_analytics()
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = crawler, public AS $$
  WITH f AS (
    SELECT company_slug, company_name,
           coalesce(nullif(seniority, ''), 'unknown') AS sen,
           CASE lower(coalesce(location_type, ''))
             WHEN 'remote' THEN 'remote' WHEN 'telecommute' THEN 'remote'
             WHEN 'hybrid' THEN 'hybrid'
             WHEN 'onsite' THEN 'onsite' WHEN 'on_site' THEN 'onsite'
             ELSE 'unspecified' END AS wt,
           coalesce(source, 'unknown') AS src,
           (coalesce(eff_at, posted_at) AT TIME ZONE 'UTC')::date AS day
    FROM crawler.job_feed
  ), tot AS (SELECT count(*) AS n FROM f)
  SELECT jsonb_build_object(
    'total', (SELECT n FROM tot),
    'companies_with_jobs', (SELECT count(DISTINCT company_slug) FROM f),
    'by_seniority', coalesce((SELECT jsonb_agg(jsonb_build_object('bucket', sen, 'count', c) ORDER BY c DESC)
                              FROM (SELECT sen, count(*) c FROM f GROUP BY sen) s), '[]'::jsonb),
    'by_work_type', coalesce((SELECT jsonb_agg(jsonb_build_object('type', wt, 'count', c) ORDER BY c DESC)
                              FROM (SELECT wt, count(*) c FROM f GROUP BY wt) s), '[]'::jsonb),
    'by_source',    coalesce((SELECT jsonb_agg(jsonb_build_object('source', src, 'count', c) ORDER BY c DESC)
                              FROM (SELECT src, count(*) c FROM f GROUP BY src) s), '[]'::jsonb),
    'top_companies', coalesce((SELECT jsonb_agg(jsonb_build_object('slug', company_slug, 'name', nm, 'count', c) ORDER BY c DESC)
                               FROM (SELECT company_slug, max(company_name) nm, count(*) c FROM f
                                     WHERE company_slug IS NOT NULL GROUP BY company_slug ORDER BY c DESC LIMIT 10) s), '[]'::jsonb),
    'posted_by_day', coalesce((SELECT jsonb_agg(jsonb_build_object('day', day, 'count', c) ORDER BY day)
                               FROM (SELECT day, count(*) c FROM f GROUP BY day) s), '[]'::jsonb),
    'mid_share_pct', (SELECT round(100.0 * count(*) FILTER (WHERE sen = 'mid') / nullif(count(*), 0), 1) FROM f)
  )
$$;

REVOKE ALL ON FUNCTION crawler.company_job_counts(int)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION crawler.job_feed_facet(text, text, int)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION crawler.job_feed_sources()                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION crawler.jobs_feed_analytics()              FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION crawler.company_job_counts(int)         TO service_role;
GRANT EXECUTE ON FUNCTION crawler.job_feed_facet(text, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION crawler.job_feed_sources()              TO service_role;
GRANT EXECUTE ON FUNCTION crawler.jobs_feed_analytics()           TO service_role;

-- ── digest_runs: one digest run per IST day, across all app instances ───────
-- server.js (lib/jobsDigest.js) calls claim_digest_run() before sending. The
-- PRIMARY KEY on run_date makes the claim atomic; a run that failed, or one
-- still 'running' after 2h (crashed instance), can be claimed again.
CREATE TABLE IF NOT EXISTS public.digest_runs (
  run_date     date PRIMARY KEY,
  instance     text,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  stats        jsonb
);
ALTER TABLE public.digest_runs ENABLE ROW LEVEL SECURITY;  -- no policies: server-only
REVOKE ALL ON public.digest_runs FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.claim_digest_run(p_run_date date, p_instance text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  INSERT INTO public.digest_runs AS d (run_date, instance, status)
  VALUES (p_run_date, p_instance, 'running')
  ON CONFLICT (run_date) DO UPDATE
    SET instance = EXCLUDED.instance, status = 'running', started_at = now(), finished_at = NULL
    WHERE d.status = 'failed'
       OR (d.status = 'running' AND d.started_at < now() - interval '2 hours');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END
$$;

CREATE OR REPLACE FUNCTION public.finish_digest_run(p_run_date date, p_status text, p_stats jsonb DEFAULT NULL)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.digest_runs
     SET status = CASE WHEN p_status = 'done' THEN 'done' ELSE 'failed' END,
         finished_at = now(), stats = p_stats
   WHERE run_date = p_run_date;
  DELETE FROM public.digest_runs WHERE run_date < p_run_date - 60;
$$;

REVOKE ALL ON FUNCTION public.claim_digest_run(date, text)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_digest_run(date, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_digest_run(date, text)        TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_digest_run(date, text, jsonb) TO service_role;

-- ── verify ──────────────────────────────────────────────────────────────────
-- SELECT * FROM crawler.company_job_counts(10);
-- SELECT * FROM crawler.job_feed_facet('company_name', 'goo', 10);
-- SELECT crawler.jobs_feed_analytics();
-- SELECT public.claim_digest_run(current_date, 'test');  -- true, then false

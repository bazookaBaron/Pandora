-- ============================================================================
-- 36_market_snapshots.sql
-- Daily job-market snapshots (Adzuna public data) for Jobs -> Analytics.
-- One row per (country, day). Written + read ONLY by the Express server with
-- the service role; browser roles get no access (RLS on, no policies).
-- Idempotent. Numbering: 33-35 are taken on other branches, so this is 36.
-- ============================================================================
create table if not exists public.market_snapshots (
  id         bigint generated always as identity primary key,
  country    text   not null check (country in ('IN','US')),
  taken_on   date   not null,
  data       jsonb  not null default '{}'::jsonb,   -- {"pending":true} while a run holds the claim
  source     text   not null default 'adzuna',
  created_at timestamptz not null default now(),
  unique (country, taken_on)
);

create index if not exists market_snapshots_country_day_idx
  on public.market_snapshots (country, taken_on desc);

alter table public.market_snapshots enable row level security;
revoke all on public.market_snapshots from anon, authenticated;

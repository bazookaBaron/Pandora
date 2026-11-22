-- On-demand job search per user (a query the 3-day pool doesn't cover).
-- Written by the Pandora API (service role), processed by AutoJobApplier saas discovery.
create table if not exists public.aa_discovery_requests (
  id            bigserial primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  titles        text[] not null,
  country       text not null default 'IN',
  seniority     text,
  status        text not null default 'queued' check (status in ('queued','running','done','failed')),
  requested_at  timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  found         int,
  error         text
);
create unique index if not exists aa_discovery_requests_one_open
  on public.aa_discovery_requests(user_id) where status in ('queued','running');
create index if not exists aa_discovery_requests_queue
  on public.aa_discovery_requests(requested_at) where status = 'queued';
alter table public.aa_discovery_requests enable row level security;
-- no client policies: only service role / worker roles touch it

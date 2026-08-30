-- ============================================================================
-- 13_blogs.sql  —  Blog content table for the public /blog + /blog/:slug routes
-- + RLS + indexes + updated_at touch trigger + ONE placeholder published row.
-- Idempotent. Run in the Supabase SQL Editor AFTER sql/06 (needs
-- public.touch_updated_at).
--
-- SECURITY MODEL
--  • Anyone (anon or authenticated) may SELECT rows where published = true.
--  • ALL writes go through the service-role key (server-side only) — anon and
--    authenticated have no insert/update/delete.
--  • server.js reads this table with the service-role client to build the
--    server-side <head> for /blog/:slug (canonical, OG/Twitter, JSON-LD Article)
--    before any JS runs.
--
-- NOTE: the 'welcome' row below is a PLACEHOLDER so Part 2's checkpoint has a
-- real /blog/:slug to curl. Part 4 publishes the real posts and removes/replaces
-- this one.
-- ============================================================================

create table if not exists public.blogs (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  excerpt text not null,
  content text not null,
  cover_image_url text,
  tags text[] default '{}',
  category text,
  meta_title text not null,
  meta_description text not null,
  reading_time_minutes int,
  published boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_blogs_published on public.blogs(published, published_at desc);
create unique index if not exists idx_blogs_slug on public.blogs(slug);

-- touch trigger (reuse public.touch_updated_at from sql/06)
drop trigger if exists trg_blogs_touch on public.blogs;
create trigger trg_blogs_touch before update on public.blogs
  for each row execute function public.touch_updated_at();

-- RLS: anyone may read PUBLISHED rows; writes are service-role only
alter table public.blogs enable row level security;
drop policy if exists "blogs_select_published" on public.blogs;
create policy "blogs_select_published" on public.blogs
  for select to anon, authenticated using (published = true);
revoke insert, update, delete on public.blogs from anon, authenticated;

-- placeholder published post so /blog/:slug works before Part 4 (Part 4 replaces/removes it)
insert into public.blogs (slug, title, excerpt, content, category, meta_title, meta_description, reading_time_minutes, published, published_at)
values (
  'welcome',
  'Welcome to the Resume Optimizer blog',
  'Short posts on interview prep, system design, and getting past ATS filters.',
  E'This is a placeholder post used to wire up the blog routes. Real articles are published separately.\n\n## What you will find here\n\nPractical, specific guidance — not listicles.',
  'meta',
  'Resume Optimizer Blog — Interview Prep & Resume Tips',
  'Practical guides on system design interviews, ATS-friendly resumes, and technical interview prep from the Resume Optimizer team.',
  1, true, now()
)
on conflict (slug) do nothing;

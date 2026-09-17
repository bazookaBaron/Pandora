-- Geo-based pricing (INR for India, USD elsewhere). Nullable, no default —
-- new signups get it filled in by POST /api/profile/detect-country (IP-based,
-- fires once per login from AuthContext.jsx) on their first SIGNED_IN event.
alter table public.profiles add column if not exists country text;

-- One-time backfill: today's users are all mock/test accounts representing
-- Indian users, so they get 'IN' directly rather than waiting on next-login
-- detection. This is a one-time statement, not something future migrations
-- should repeat — new rows are created with country = null and filled in by
-- the detect-country endpoint instead.
update public.profiles set country = 'IN' where country is null;

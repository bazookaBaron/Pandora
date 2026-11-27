-- ============================================================================
-- 54b_reset_ip_country_subscriptions.sql   ONE-OFF. NOT auto-run. Run by hand.
-- Fixes Indian users who were stored as non-IN (INR flashed, then USD) because
-- the app saw a proxy / CDN IP instead of the real client. Clearing the row
-- makes POST /api/profile/detect-country re-detect on the next login.
-- Requires sql/54 (country_source). Review the SELECT first.
-- ============================================================================

-- 1) Dry run: who would be reset?
SELECT p.id, p.country, p.country_source
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
 WHERE p.country IS NOT NULL
   AND p.country <> 'IN'
   AND p.country_source IS DISTINCT FROM 'user'
   AND (
        u.phone LIKE '91%'
     OR EXISTS (SELECT 1 FROM public.processed_payments pp WHERE pp.user_id = p.id AND pp.currency = 'INR')
   );

-- 2) Targeted reset (Indian phone or an INR payment). Uncomment to run.
-- UPDATE public.profiles p
--    SET country = NULL, country_source = NULL
--   FROM auth.users u
--  WHERE u.id = p.id
--    AND p.country IS NOT NULL AND p.country <> 'IN'
--    AND p.country_source IS DISTINCT FROM 'user'
--    AND (u.phone LIKE '91%'
--         OR EXISTS (SELECT 1 FROM public.processed_payments pp WHERE pp.user_id = p.id AND pp.currency = 'INR'));

-- 3) Or the blunt option: clear EVERY IP-detected country so all users re-detect.
-- UPDATE public.profiles SET country = NULL, country_source = NULL WHERE country_source = 'ip';

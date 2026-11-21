-- ============================================================================
-- 05_mail_auth_retention.sql — MAIL project only (never the main Vloombox project). Apply AFTER 04. Idempotent.
--
--  1. auth_ok: the Email Worker now forwards the SPF / DKIM / DMARC verdict that Cloudflare Email Routing wrote
--     (topmost ARC-Authentication-Results / Authentication-Results from mx.cloudflare.net). The API sets
--     auth_ok = true only for DMARC pass (or, without a DMARC verdict, a DKIM pass aligned with the From domain).
--     Unauthenticated mail (auth_ok false / NULL) is stored WITHOUT codes and links, is never category 'code',
--     never wakes a waiting worker (no pg_notify), and the Python OTP reader must ignore it as well
--     (WHERE auth_ok IS TRUE).
--  2. Retention: verification codes now expire 7 days after arrival; mail to an unknown alias (user_id NULL)
--     3 days after arrival, whatever its category. The daily cleanup (lib/autoapply/mailJobs.js) deletes
--     expires_at < now() for the expiring categories, plus every user_id NULL row past expires_at.
-- ============================================================================

ALTER TABLE public.aa_mail_events ADD COLUMN IF NOT EXISTS auth_ok boolean;

-- backfill expiry for rows stored before this file
UPDATE public.aa_mail_events SET expires_at = received_at + interval '7 days'
 WHERE category = 'code' AND user_id IS NOT NULL AND expires_at IS NULL;
UPDATE public.aa_mail_events SET expires_at = received_at + interval '3 days'
 WHERE user_id IS NULL AND (expires_at IS NULL OR expires_at > received_at + interval '3 days');

-- cleanup scans
CREATE INDEX IF NOT EXISTS idx_aa_mail_expires_code ON public.aa_mail_events (expires_at)
  WHERE expires_at IS NOT NULL AND category = 'code';
CREATE INDEX IF NOT EXISTS idx_aa_mail_expires_unknown ON public.aa_mail_events (expires_at)
  WHERE expires_at IS NOT NULL AND user_id IS NULL;

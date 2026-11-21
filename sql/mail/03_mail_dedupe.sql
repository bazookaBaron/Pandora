-- ============================================================================
-- AutoApply MAIL database, migration 03 (apply to the SEPARATE mail project, after 02).
-- Idempotent. Apply BEFORE (or together with) deploying the API that writes dedupe_key; the API falls back to a
-- plain insert while the column / index is missing, so the order is not critical, but dedupe only works after this.
--
-- Why: the Email Worker retries a delivery whose response it never saw (network timeout, a 5xx after the row
-- was already inserted, the every-5-minutes D1 retry cron). Each retry used to store the same mail again and send
-- a second push. The API now computes
--     dedupe_key = sha256(recipient local part + Message-ID)            (fallback without a Message-ID:
--                  sha256(local part, from, subject, received_at, raw_key, excerpt) - identical on a retry)
-- and inserts with INSERT ... ON CONFLICT (dedupe_key) DO NOTHING; it only pushes / notifies when a row was
-- actually inserted (lib/autoapply/inbound.js storeInbound).
--
-- The unique index is deliberately NOT partial: PostgREST's on_conflict=dedupe_key needs a plain unique index or
-- constraint on exactly that column. NULLs never conflict, so rows stored before this migration (dedupe_key NULL)
-- are fine.
-- ============================================================================

ALTER TABLE public.aa_mail_events ADD COLUMN IF NOT EXISTS dedupe_key text;

-- Existing rows keep dedupe_key NULL (no backfill needed: only new deliveries can be retried).
CREATE UNIQUE INDEX IF NOT EXISTS uq_aa_mail_events_dedupe_key ON public.aa_mail_events (dedupe_key);

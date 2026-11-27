-- ============================================================================
-- 07_mail_kind_verify.sql — MAIL project only. Apply AFTER 06. Idempotent. Migration file only: run by hand.
-- Records how an interview / assessment / offer tag was decided (frontend/lib/autoapply/classify.js, rule-based, no AI):
--   kind_source  'rule_confirmed'  candidate tag backed by corroborating evidence (.ics, meeting / assessment link,
--                                  explicit scheduling phrase, offer-letter phrase) and not an auto-acknowledgement
--                'rule_weak'       candidate tag was NOT confirmed and was downgraded to received / recruiter / other
--                NULL             not an interview / assessment / offer candidate (or stored before this migration)
-- The API tolerates the column being absent (stores without it until this runs).
-- ============================================================================
ALTER TABLE public.aa_mail_events ADD COLUMN IF NOT EXISTS kind_source text;

DO $$ BEGIN
  ALTER TABLE public.aa_mail_events
    ADD CONSTRAINT aa_mail_events_kind_source_chk CHECK (kind_source IS NULL OR kind_source IN ('rule_confirmed','rule_weak'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

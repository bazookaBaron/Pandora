-- 24_autoapply_packs.sql — AutoApply packs are now 50 and 100 only (80 removed).
-- Prices live in frontend/config/tiers.js (AUTO_APPLY.packs); this only narrows
-- the pack_size CHECK that 20_autoapply.sql created as (50,80,100).
--
-- Legacy rows: batches already bought as 80-packs must keep working (status,
-- credits_used and refund updates re-check CHECK constraints on every UPDATE,
-- so a plain IN (50,100) would break them). 80 stays allowed only for rows
-- created before this change; every new batch must be 50 or 100.
-- Idempotent: safe to run more than once.

-- One DO block = one statement: the old constraint is only dropped if the new one is added. The cutoff is
-- the later of 2026-11-21 IST and just after the newest existing 80-pack row, so the CHECK can never fail on
-- an 80-pack bought before this migration ran (old API still live) and stays the same on a re-run.
DO $$
DECLARE
  c record;
  cutoff timestamptz;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.aa_batches'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%pack_size%'
  LOOP
    EXECUTE format('ALTER TABLE public.aa_batches DROP CONSTRAINT %I', c.conname);
  END LOOP;

  SELECT GREATEST(timestamptz '2026-11-21 00:00:00+05:30', max(created_at) + interval '1 second')
    INTO cutoff
    FROM public.aa_batches WHERE pack_size = 80;

  EXECUTE format(
    'ALTER TABLE public.aa_batches ADD CONSTRAINT aa_batches_pack_size_check CHECK (
       pack_size IN (50,100) OR (pack_size = 80 AND created_at < %L::timestamptz))',
    cutoff);
END $$;

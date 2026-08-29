-- ============================================================================
-- 02_indexes_constraints.sql
-- Purpose: add the missing UNIQUE constraint + query indexes on
--          interview_questions.
--
-- PRECONDITION: 00_introspect.sql section [G] returned ZERO rows (no duplicate
-- (subcategory, external_id) pairs). If it returned rows, resolve duplicates
-- first — do NOT run the constraint block below until it is clean.
--
-- Idempotent: re-running is a no-op. Run in the Supabase SQL Editor.
-- ============================================================================

-- 1) UNIQUE (subcategory, external_id) — lets the ingestion pipeline upsert on a
--    natural key instead of guessing at id. Added only if absent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conrelid = 'public.interview_questions'::regclass
      AND  conname  = 'uq_iq_subcategory_external_id'
  ) THEN
    ALTER TABLE public.interview_questions
      ADD CONSTRAINT uq_iq_subcategory_external_id
      UNIQUE (subcategory, external_id);
  END IF;
END $$;

-- 2) Composite index for the left-panel + question-list queries:
--    WHERE subcategory = $1 ORDER BY order_number
--    (also covers "GROUP BY category, subcategory" scans).
CREATE INDEX IF NOT EXISTS idx_iq_category_subcategory_order
  ON public.interview_questions (category, subcategory, order_number);

-- 3) Standalone subcategory index — the hot filter in useInterviewQuestions().
CREATE INDEX IF NOT EXISTS idx_iq_subcategory
  ON public.interview_questions (subcategory);

-- 4) answer_status index — for "how many answered per subcategory" style reads
--    and any admin dashboard filtering by generation state.
CREATE INDEX IF NOT EXISTS idx_iq_answer_status
  ON public.interview_questions (answer_status);

-- Verify:
-- SELECT indexname, indexdef FROM pg_indexes
-- WHERE schemaname='public' AND tablename='interview_questions' ORDER BY indexname;

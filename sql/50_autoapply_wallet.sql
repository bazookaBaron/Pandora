-- 50_autoapply_wallet.sql — AutoApply wallet (replaces pack purchases).   NOT applied by anyone but the owner.
-- Idempotent. Apply AFTER sql/20..49 and BEFORE deploying the wallet API / scheduler / worker / aa-control build.
--
-- Model (all amounts in paise, INR; GST inclusive):
--   aa_wallets        one row per user: balance_paise (spendable) and held_paise (reserved for applications that are
--                     in flight right now).
--   aa_wallet_ledger  append-only; delta_paise = change of the spendable balance, held_delta_paise = change of the
--                     held amount.  topup (+bal) / hold (-bal, +held: ONE task's reservation) / capture (-held: the
--                     application was submitted) / release (+bal, -held: skipped, failed, needs_you, lease lost) /
--                     adjust / migration.  Outstanding reservation of a task = SUM(held_delta_paise) WHERE task_id.
--   aa_batches        wallet batches have rate_paise (product rate) and rate_service_paise; rate_paise IS NULL marks
--                     a legacy pack batch (untouched behaviour). A wallet batch is not tied to one company kind
--                     (pack_kind NULL). There is NO batch-level hold: when a worker claims a task, that job's rate
--                     (product = rate_paise, otherwise rate_service_paise, by aa_jobs.company_kind) is reserved from
--                     the balance in the same transaction (aa_wallet_reserve); it is captured when the task ends
--                     'applied' and released otherwise. Not enough balance -> the claim skips the task (CLAIM_SQL
--                     checks it, so it is not "due" and no GPU wakes) and the scheduler parks the batch in
--                     'waiting_funds'; a top-up resumes it at once (aa_wallet_topup).
-- Every mutation goes through SECURITY DEFINER functions with row locks (lock order: task -> batch -> wallet) and a
-- pinned search_path; they are revoked from PUBLIC / anon / authenticated. RLS: users read their own rows only.

-- ── 1. tables ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.aa_wallets (
  user_id        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance_paise  bigint NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
  held_paise     bigint NOT NULL DEFAULT 0 CHECK (held_paise >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.aa_wallet_ledger (
  id                   bigserial PRIMARY KEY,
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  delta_paise          bigint NOT NULL DEFAULT 0,
  held_delta_paise     bigint NOT NULL DEFAULT 0,
  kind                 text NOT NULL CHECK (kind IN ('topup','hold','capture','release','adjust','migration')),
  batch_id             uuid REFERENCES public.aa_batches(id) ON DELETE SET NULL,
  task_id              uuid,                          -- no FK: tasks are deleted by retention, the ledger stays
  razorpay_order_id    text,
  razorpay_payment_id  text,
  idempotency_key      text,
  note                 text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_aa_wl_topup_order   ON public.aa_wallet_ledger (razorpay_order_id)   WHERE kind = 'topup';
CREATE UNIQUE INDEX IF NOT EXISTS uq_aa_wl_topup_payment ON public.aa_wallet_ledger (razorpay_payment_id) WHERE kind = 'topup';
CREATE UNIQUE INDEX IF NOT EXISTS uq_aa_wl_capture_task  ON public.aa_wallet_ledger (task_id)  WHERE kind = 'capture';
CREATE UNIQUE INDEX IF NOT EXISTS uq_aa_wl_idem_key      ON public.aa_wallet_ledger (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aa_wl_user_created ON public.aa_wallet_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aa_wl_batch        ON public.aa_wallet_ledger (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aa_wl_task         ON public.aa_wallet_ledger (task_id) WHERE task_id IS NOT NULL;

ALTER TABLE public.aa_wallets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aa_wallet_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.aa_wallets, public.aa_wallet_ledger FROM anon, authenticated;
GRANT SELECT ON public.aa_wallets, public.aa_wallet_ledger TO authenticated;
-- the service role reads; it writes only through the functions below
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.aa_wallets, public.aa_wallet_ledger FROM service_role;
GRANT SELECT ON public.aa_wallets, public.aa_wallet_ledger TO service_role;
DROP POLICY IF EXISTS aa_wallets_read_own ON public.aa_wallets;
CREATE POLICY aa_wallets_read_own ON public.aa_wallets FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS aa_wallet_ledger_read_own ON public.aa_wallet_ledger;
CREATE POLICY aa_wallet_ledger_read_own ON public.aa_wallet_ledger FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

-- ── 2. aa_batches ───────────────────────────────────────────────────────────
ALTER TABLE public.aa_batches ADD COLUMN IF NOT EXISTS rate_paise          integer CHECK (rate_paise IS NULL OR rate_paise > 0);
ALTER TABLE public.aa_batches ADD COLUMN IF NOT EXISTS rate_service_paise  integer CHECK (rate_service_paise IS NULL OR rate_service_paise > 0);
ALTER TABLE public.aa_batches ADD COLUMN IF NOT EXISTS funds_notified_at   timestamptz;   -- ONE push per entry into waiting_funds
ALTER TABLE public.aa_batches ADD COLUMN IF NOT EXISTS idle_since          timestamptz;   -- scheduler: since when no new matches
ALTER TABLE public.aa_batches ADD COLUMN IF NOT EXISTS closed_at           timestamptz;
ALTER TABLE public.aa_batches ADD COLUMN IF NOT EXISTS closed_reason       text;
ALTER TABLE public.aa_batches ALTER COLUMN pack_kind DROP NOT NULL;                    -- wallet batches span both kinds

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.aa_batches'::regclass AND contype = 'c'
      AND (pg_get_constraintdef(oid) ILIKE '%pack_size%' OR pg_get_constraintdef(oid) ILIKE '%pending_payment%')
  LOOP
    EXECUTE format('ALTER TABLE public.aa_batches DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.aa_batches ADD CONSTRAINT aa_batches_pack_size_check
  CHECK (pack_size IN (25,50,100) OR (pack_size = 80 AND rate_paise IS NULL));
ALTER TABLE public.aa_batches ADD CONSTRAINT aa_batches_status_check CHECK (status IN (
  'pending_payment','paid','shortlisting','review','running','paused','waiting_supply','waiting_profile',
  'waiting_funds','completed','finished_partial','expired','refund_due','refunding','refunded','cancelled'));

-- ── 3. guard trigger: wallet batches never get a cash refund and never get their expiry pushed ──────────────
-- (the sql/45 behaviour for legacy pack batches is kept verbatim below)
CREATE OR REPLACE FUNCTION public.aa_batches_refund_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  open_states text[] := ARRAY['paid','shortlisting','review','running','paused','waiting_supply','waiting_profile'];
BEGIN
  IF NEW.rate_paise IS NOT NULL THEN
    -- wallet batch: unused money returns to the wallet (aa_wallet_close_batch), never to the card
    IF NEW.status = 'refund_due' AND OLD.status IS DISTINCT FROM 'refund_due' AND NEW.refund_approved_at IS NULL THEN
      NEW.status := CASE WHEN COALESCE(NEW.credits_used,0) >= COALESCE(NEW.credits_total,0) THEN 'completed' ELSE 'finished_partial' END;
    END IF;
    IF NEW.status = 'expired' AND OLD.status IS DISTINCT FROM 'expired' THEN
      NEW.status := CASE WHEN COALESCE(NEW.credits_used,0) >= COALESCE(NEW.credits_total,0) THEN 'completed' ELSE 'finished_partial' END;
    END IF;
    RETURN NEW;                                       -- no expires_at bump
  END IF;

  IF NEW.status = 'refund_due' AND OLD.status IS DISTINCT FROM 'refund_due' AND OLD.status IS DISTINCT FROM 'refunding'
     AND NEW.refund_approved_at IS NULL
     AND COALESCE(NEW.refund_reason, '') NOT IN ('late_payment_auto_refund','monthly_cap_auto_refund','coupon_unavailable_auto_refund') THEN
    IF COALESCE(NEW.credits_used, 0) >= COALESCE(NEW.credits_total, 0) THEN
      NEW.status := 'completed';
    ELSIF OLD.status = ANY (open_states) THEN
      NEW.status := OLD.status;
    ELSE
      NEW.status := 'paused';
    END IF;
  END IF;
  IF NEW.status = 'expired' AND OLD.status IS DISTINCT FROM 'expired'
     AND COALESCE(NEW.credits_used, 0) < COALESCE(NEW.credits_total, 0) THEN
    NEW.status := CASE WHEN OLD.status = ANY (open_states) THEN OLD.status ELSE 'paused' END;
  END IF;
  IF NEW.status = ANY (open_states) AND COALESCE(NEW.credits_used, 0) < COALESCE(NEW.credits_total, 0)
     AND NEW.expires_at IS NOT NULL AND NEW.expires_at < now() + interval '3 days' THEN
    NEW.expires_at := now() + interval '7 days';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_aa_batches_refund_guard ON public.aa_batches;
CREATE TRIGGER trg_aa_batches_refund_guard BEFORE UPDATE ON public.aa_batches
  FOR EACH ROW EXECUTE FUNCTION public.aa_batches_refund_guard();
REVOKE EXECUTE ON FUNCTION public.aa_batches_refund_guard() FROM PUBLIC, anon, authenticated;

-- ── 4. internal helpers (no grants: only the functions below call them) ─────────────────────────────────────
-- Caller holds the wallet row lock. Releases what is still reserved for ONE task (idempotent: 0 when nothing is).
CREATE OR REPLACE FUNCTION public.aa_wallet_release_core(p_task uuid, p_batch uuid, p_user uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE rem bigint;
BEGIN
  SELECT COALESCE(SUM(held_delta_paise), 0) INTO rem FROM public.aa_wallet_ledger WHERE task_id = p_task;
  IF rem > 0 THEN
    INSERT INTO public.aa_wallet_ledger (user_id, delta_paise, held_delta_paise, kind, batch_id, task_id, note)
    VALUES (p_user, rem, -rem, 'release', p_batch, p_task, 'reservation released');
    UPDATE public.aa_wallets SET balance_paise = balance_paise + rem, held_paise = held_paise - rem, updated_at = now()
     WHERE user_id = p_user;
    RETURN rem;
  END IF;
  RETURN 0;
END $$;
REVOKE ALL ON FUNCTION public.aa_wallet_release_core(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Caller holds the task + batch row locks. Charges the rate of this task's job kind, once: from the task's
-- reservation when there is one, else (a verify_submission confirmed later, a lost lease) straight from the balance
-- when it covers it. Nothing is charged when the money is not there ('no_funds'): the application is already out.
CREATE OR REPLACE FUNCTION public.aa_wallet_capture_core(p_task public.aa_tasks, p_batch public.aa_batches) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE jkind text; amt integer; outst bigint; bal bigint; led bigint; from_hold boolean;
BEGIN
  IF p_batch.rate_paise IS NULL THEN
    RETURN jsonb_build_object('wallet', false, 'captured', false, 'reason', 'not_wallet_batch');
  END IF;
  IF p_batch.status IN ('refund_due','refunding','refunded') THEN
    RETURN jsonb_build_object('wallet', true, 'captured', false, 'reason', 'batch_' || p_batch.status);
  END IF;
  IF p_batch.credits_used >= p_batch.credits_total THEN
    RETURN jsonb_build_object('wallet', true, 'captured', false, 'reason', 'credits_exhausted');
  END IF;
  SELECT company_kind INTO jkind FROM public.aa_jobs WHERE job_key = p_task.job_key;
  amt := CASE WHEN jkind = 'product' THEN p_batch.rate_paise ELSE COALESCE(p_batch.rate_service_paise, p_batch.rate_paise) END;
  INSERT INTO public.aa_wallets (user_id) VALUES (p_batch.user_id) ON CONFLICT DO NOTHING;
  SELECT balance_paise INTO bal FROM public.aa_wallets WHERE user_id = p_batch.user_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.aa_wallet_ledger WHERE task_id = p_task.id AND kind = 'capture') THEN
    RETURN jsonb_build_object('wallet', true, 'captured', false, 'reason', 'already_captured');
  END IF;
  SELECT COALESCE(SUM(held_delta_paise), 0) INTO outst FROM public.aa_wallet_ledger WHERE task_id = p_task.id;
  from_hold := outst >= amt;
  IF NOT from_hold THEN
    PERFORM public.aa_wallet_release_core(p_task.id, p_batch.id, p_batch.user_id);   -- a short reservation goes back first
    SELECT balance_paise INTO bal FROM public.aa_wallets WHERE user_id = p_batch.user_id;
    IF bal < amt THEN
      RETURN jsonb_build_object('wallet', true, 'captured', false, 'reason', 'no_funds');
    END IF;
  END IF;
  INSERT INTO public.aa_wallet_ledger (user_id, delta_paise, held_delta_paise, kind, batch_id, task_id, note)
  VALUES (p_batch.user_id, CASE WHEN from_hold THEN 0 ELSE -amt END, CASE WHEN from_hold THEN -amt ELSE 0 END,
          'capture', p_batch.id, p_task.id, COALESCE(jkind, 'unknown'))
  ON CONFLICT DO NOTHING RETURNING id INTO led;
  IF led IS NULL THEN
    RETURN jsonb_build_object('wallet', true, 'captured', false, 'reason', 'already_captured');
  END IF;
  IF from_hold THEN
    UPDATE public.aa_wallets SET held_paise = held_paise - amt, updated_at = now() WHERE user_id = p_batch.user_id;
    IF outst > amt THEN                                   -- never reserved more than one rate, but be exact
      UPDATE public.aa_wallets SET held_paise = held_paise - (outst - amt), balance_paise = balance_paise + (outst - amt)
       WHERE user_id = p_batch.user_id;
      INSERT INTO public.aa_wallet_ledger (user_id, delta_paise, held_delta_paise, kind, batch_id, task_id, note)
      VALUES (p_batch.user_id, outst - amt, -(outst - amt), 'release', p_batch.id, p_task.id, 'excess reservation');
    END IF;
  ELSE
    UPDATE public.aa_wallets SET balance_paise = balance_paise - amt, updated_at = now() WHERE user_id = p_batch.user_id;
  END IF;
  UPDATE public.aa_batches
     SET credits_used = credits_used + 1,
         status = CASE WHEN status IN ('cancelled','finished_partial') THEN status
                       WHEN credits_used + 1 >= credits_total THEN 'completed' ELSE status END,
         closed_at = CASE WHEN status NOT IN ('cancelled','finished_partial') AND credits_used + 1 >= credits_total
                          THEN now() ELSE closed_at END
   WHERE id = p_batch.id;
  RETURN jsonb_build_object('wallet', true, 'captured', true, 'reason', '', 'amount_paise', amt);
END $$;
REVOKE ALL ON FUNCTION public.aa_wallet_capture_core(public.aa_tasks, public.aa_batches) FROM PUBLIC, anon, authenticated, service_role;

-- ── 5. public functions ─────────────────────────────────────────────────────────────────────────────────────
-- Top-up: idempotent per Razorpay order AND per payment. Batches parked in 'waiting_funds' resume at once.
-- -> {credited, duplicate, balance_paise, resumed}
CREATE OR REPLACE FUNCTION public.aa_wallet_topup(p_user uuid, p_order text, p_payment text, p_amount bigint, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE led bigint; bal bigint; n integer := 0;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'invalid_amount'; END IF;
  IF COALESCE(p_order, '') = '' OR COALESCE(p_payment, '') = '' THEN RAISE EXCEPTION 'order_and_payment_required'; END IF;
  INSERT INTO public.aa_wallets (user_id) VALUES (p_user) ON CONFLICT DO NOTHING;
  SELECT balance_paise INTO bal FROM public.aa_wallets WHERE user_id = p_user FOR UPDATE;
  INSERT INTO public.aa_wallet_ledger (user_id, delta_paise, kind, razorpay_order_id, razorpay_payment_id, note)
  VALUES (p_user, p_amount, 'topup', p_order, p_payment, p_note)
  ON CONFLICT DO NOTHING RETURNING id INTO led;
  IF led IS NULL THEN
    RETURN jsonb_build_object('credited', false, 'duplicate', true, 'balance_paise', bal, 'resumed', 0);
  END IF;
  UPDATE public.aa_wallets SET balance_paise = balance_paise + p_amount, updated_at = now()
   WHERE user_id = p_user RETURNING balance_paise INTO bal;
  -- auto-resume, no manual retrigger: 'running' when the batch already has tasks, else back to 'shortlisting'
  UPDATE public.aa_batches b
     SET status = CASE WHEN EXISTS (SELECT 1 FROM public.aa_tasks t WHERE t.batch_id = b.id) THEN 'running' ELSE 'shortlisting' END,
         funds_notified_at = NULL
   WHERE b.user_id = p_user AND b.status = 'waiting_funds' AND b.rate_paise IS NOT NULL
     AND bal >= COALESCE(b.rate_service_paise, b.rate_paise);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('credited', true, 'duplicate', false, 'balance_paise', bal, 'resumed', n);
END $$;

-- Start a batch (status 'shortlisting'). No money moves: it needs a balance of at least one application at the
-- top rate (p_rate_product); applications are reserved / charged one by one later.
CREATE OR REPLACE FUNCTION public.aa_wallet_start_batch(
  p_user uuid, p_size integer, p_rate_product integer, p_rate_service integer,
  p_window_days integer DEFAULT 30, p_must text[] DEFAULT '{}', p_valid_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE bal bigint; bid uuid;
BEGIN
  IF p_size NOT IN (25, 50, 100) THEN RETURN jsonb_build_object('ok', false, 'reason', 'bad_size'); END IF;
  IF p_rate_product IS NULL OR p_rate_product <= 0 OR p_rate_service IS NULL OR p_rate_service <= 0
     OR p_rate_service > p_rate_product THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_rate');
  END IF;
  INSERT INTO public.aa_wallets (user_id) VALUES (p_user) ON CONFLICT DO NOTHING;
  SELECT balance_paise INTO bal FROM public.aa_wallets WHERE user_id = p_user FOR UPDATE;
  IF bal < p_rate_product THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance', 'balance_paise', bal,
                              'needed_paise', p_rate_product, 'shortfall_paise', p_rate_product - bal);
  END IF;
  INSERT INTO public.aa_batches (user_id, pack_kind, pack_size, price_paise, currency, window_days, status,
                                 credits_total, rate_paise, rate_service_paise, purchased_at, expires_at, must_companies)
  VALUES (p_user, NULL, p_size, 0, 'INR', LEAST(GREATEST(COALESCE(p_window_days, 30), 1), 30), 'shortlisting',
          p_size, p_rate_product, p_rate_service, now(), now() + make_interval(days => GREATEST(COALESCE(p_valid_days, 30), 1)),
          COALESCE(p_must, '{}'))
  RETURNING id INTO bid;
  RETURN jsonb_build_object('ok', true, 'batch_id', bid, 'balance_paise', bal);
END $$;

-- Reserve one task's rate. Called by the worker INSIDE the claim transaction (right after CLAIM_SQL): exactly once
-- per task (an existing reservation or capture is returned as such), row-locked. Legacy batches: wallet=false.
CREATE OR REPLACE FUNCTION public.aa_wallet_reserve(p_task uuid, p_worker text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.aa_tasks; b public.aa_batches; jkind text; amt integer; bal bigint; outst bigint;
BEGIN
  SELECT * INTO t FROM public.aa_tasks WHERE id = p_task FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('wallet', true, 'ok', false, 'reason', 'task_missing'); END IF;
  IF p_worker IS NOT NULL AND t.claimed_by IS DISTINCT FROM p_worker THEN
    RETURN jsonb_build_object('wallet', true, 'ok', false, 'reason', 'not_held_by_worker');
  END IF;
  SELECT * INTO b FROM public.aa_batches WHERE id = t.batch_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('wallet', true, 'ok', false, 'reason', 'batch_missing'); END IF;
  IF b.rate_paise IS NULL THEN RETURN jsonb_build_object('wallet', false, 'ok', true, 'reason', 'not_wallet_batch'); END IF;
  SELECT company_kind INTO jkind FROM public.aa_jobs WHERE job_key = t.job_key;
  amt := CASE WHEN jkind = 'product' THEN b.rate_paise ELSE COALESCE(b.rate_service_paise, b.rate_paise) END;
  INSERT INTO public.aa_wallets (user_id) VALUES (b.user_id) ON CONFLICT DO NOTHING;
  SELECT balance_paise INTO bal FROM public.aa_wallets WHERE user_id = b.user_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.aa_wallet_ledger WHERE task_id = p_task AND kind = 'capture') THEN
    RETURN jsonb_build_object('wallet', true, 'ok', true, 'reserved', false, 'already', true, 'amount_paise', amt);
  END IF;
  SELECT COALESCE(SUM(held_delta_paise), 0) INTO outst FROM public.aa_wallet_ledger WHERE task_id = p_task;
  IF outst > 0 THEN
    RETURN jsonb_build_object('wallet', true, 'ok', true, 'reserved', false, 'already', true, 'amount_paise', outst);
  END IF;
  IF bal < amt THEN
    RETURN jsonb_build_object('wallet', true, 'ok', false, 'reason', 'insufficient_funds', 'balance_paise', bal, 'needed_paise', amt);
  END IF;
  INSERT INTO public.aa_wallet_ledger (user_id, delta_paise, held_delta_paise, kind, batch_id, task_id, note)
  VALUES (b.user_id, -amt, amt, 'hold', b.id, p_task, COALESCE(jkind, 'unknown'));
  UPDATE public.aa_wallets SET balance_paise = balance_paise - amt, held_paise = held_paise + amt, updated_at = now()
   WHERE user_id = b.user_id;
  RETURN jsonb_build_object('wallet', true, 'ok', true, 'reserved', true, 'amount_paise', amt);
END $$;

-- Release one task's reservation (skipped / failed / needs_you / lease lost). Idempotent. -> {released_paise}
CREATE OR REPLACE FUNCTION public.aa_wallet_release_task(p_task uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.aa_tasks; r bigint;
BEGIN
  SELECT * INTO t FROM public.aa_tasks WHERE id = p_task FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('released_paise', 0, 'reason', 'task_missing'); END IF;
  IF t.status = 'applied' THEN RETURN jsonb_build_object('released_paise', 0, 'reason', 'applied'); END IF;
  PERFORM 1 FROM public.aa_wallets WHERE user_id = t.user_id FOR UPDATE;
  r := public.aa_wallet_release_core(t.id, t.batch_id, t.user_id);
  RETURN jsonb_build_object('released_paise', r);
END $$;

-- Capture one application's fee (exactly once per task). Worker result transaction / verify path.
CREATE OR REPLACE FUNCTION public.aa_wallet_capture(p_task uuid, p_worker text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.aa_tasks; b public.aa_batches;
BEGIN
  SELECT * INTO t FROM public.aa_tasks WHERE id = p_task FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('wallet', true, 'captured', false, 'reason', 'task_missing'); END IF;
  IF p_worker IS NOT NULL AND (t.claimed_by IS DISTINCT FROM p_worker
     OR t.status NOT IN ('claimed','running','waiting_code','submitting')) THEN
    RETURN jsonb_build_object('wallet', true, 'captured', false, 'reason', 'not_held_by_worker');
  END IF;
  SELECT * INTO b FROM public.aa_batches WHERE id = t.batch_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('wallet', true, 'captured', false, 'reason', 'batch_missing'); END IF;
  RETURN public.aa_wallet_capture_core(t, b);
END $$;

-- Safety net (scheduler, every pass): reservations of tasks that are no longer in flight. An 'applied' task is
-- captured, any other (queued again after a lease loss, failed, skipped, needs_you, cancelled) is released.
CREATE OR REPLACE FUNCTION public.aa_wallet_sweep_holds(p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; t public.aa_tasks; b public.aa_batches; captured integer := 0; released integer := 0; res jsonb;
BEGIN
  FOR r IN
    SELECT l.task_id FROM public.aa_wallet_ledger l WHERE l.task_id IS NOT NULL
     GROUP BY l.task_id HAVING SUM(l.held_delta_paise) > 0 LIMIT GREATEST(p_limit, 1)
  LOOP
    SELECT * INTO t FROM public.aa_tasks WHERE id = r.task_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND OR t.status IN ('claimed','running','waiting_code','submitting') THEN CONTINUE; END IF;
    SELECT * INTO b FROM public.aa_batches WHERE id = t.batch_id FOR UPDATE;
    PERFORM 1 FROM public.aa_wallets WHERE user_id = t.user_id FOR UPDATE;
    IF t.status = 'applied' THEN
      res := public.aa_wallet_capture_core(t, b);
      IF (res->>'captured')::boolean THEN
        captured := captured + 1;
      ELSE
        PERFORM public.aa_wallet_release_core(t.id, t.batch_id, t.user_id);
        released := released + 1;
      END IF;
    ELSE
      PERFORM public.aa_wallet_release_core(t.id, t.batch_id, t.user_id);
      released := released + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('captured', captured, 'released', released);
END $$;

-- Close a wallet batch: final status (when p_status is given). Nothing is held at batch level; a leftover
-- reservation of one of its tasks is released first. 'tasks_active' = an application is mid-flight: retry later.
CREATE OR REPLACE FUNCTION public.aa_wallet_close_batch(p_batch uuid, p_status text DEFAULT NULL, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b public.aa_batches; final text; r record; released bigint := 0;
BEGIN
  SELECT * INTO b FROM public.aa_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF b.rate_paise IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_wallet_batch'); END IF;
  IF b.status IN ('refund_due','refunding','refunded') THEN RETURN jsonb_build_object('ok', false, 'reason', 'refund_state'); END IF;
  IF p_status IS NOT NULL THEN
    IF p_status NOT IN ('completed','finished_partial','cancelled') THEN RETURN jsonb_build_object('ok', false, 'reason', 'bad_status'); END IF;
    IF EXISTS (SELECT 1 FROM public.aa_tasks WHERE batch_id = p_batch AND status IN ('claimed','running','waiting_code','submitting')) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'tasks_active');
    END IF;
  END IF;
  INSERT INTO public.aa_wallets (user_id) VALUES (b.user_id) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM public.aa_wallets WHERE user_id = b.user_id FOR UPDATE;
  FOR r IN SELECT l.task_id FROM public.aa_wallet_ledger l WHERE l.batch_id = p_batch AND l.task_id IS NOT NULL
            GROUP BY l.task_id HAVING SUM(l.held_delta_paise) > 0 LOOP
    released := released + public.aa_wallet_release_core(r.task_id, p_batch, b.user_id);
  END LOOP;
  final := b.status;
  IF p_status IS NOT NULL THEN
    IF b.status NOT IN ('completed','finished_partial','cancelled','expired') THEN
      final := CASE WHEN b.credits_used >= b.credits_total THEN 'completed'
                    WHEN p_status = 'completed' THEN 'finished_partial' ELSE p_status END;
    END IF;
    UPDATE public.aa_batches SET status = final, closed_at = COALESCE(closed_at, now()),
           closed_reason = COALESCE(closed_reason, p_reason), idle_since = NULL
     WHERE id = b.id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'released_paise', released, 'status', final);
END $$;

-- Manual correction by the owner (service role, psql). Idempotent per key; the balance can never go negative.
CREATE OR REPLACE FUNCTION public.aa_wallet_adjust(p_user uuid, p_delta bigint, p_kind text, p_key text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE led bigint; bal bigint;
BEGIN
  IF p_kind NOT IN ('adjust','migration') THEN RAISE EXCEPTION 'bad_kind'; END IF;
  IF COALESCE(p_key, '') = '' THEN RAISE EXCEPTION 'idempotency_key_required'; END IF;
  INSERT INTO public.aa_wallets (user_id) VALUES (p_user) ON CONFLICT DO NOTHING;
  SELECT balance_paise INTO bal FROM public.aa_wallets WHERE user_id = p_user FOR UPDATE;
  INSERT INTO public.aa_wallet_ledger (user_id, delta_paise, kind, idempotency_key, note)
  VALUES (p_user, p_delta, p_kind, p_key, p_note) ON CONFLICT DO NOTHING RETURNING id INTO led;
  IF led IS NULL THEN RETURN jsonb_build_object('applied', false, 'duplicate', true, 'balance_paise', bal); END IF;
  UPDATE public.aa_wallets SET balance_paise = balance_paise + p_delta, updated_at = now()
   WHERE user_id = p_user RETURNING balance_paise INTO bal;
  RETURN jsonb_build_object('applied', true, 'duplicate', false, 'balance_paise', bal);
END $$;

-- One-off: convert the UNUSED credits of a legacy pack batch to wallet balance at the price paid per credit
-- (price_paise x unused / credits_total, floored). Queued / shortlisted tasks are cancelled, the batch is closed
-- ('completed' when anything was used, else 'cancelled'). Refuses while an application is mid-flight.
-- Driven by frontend/scripts/migrate-pack-credits-to-wallet.mjs (dry run by default); NOT run automatically.
CREATE OR REPLACE FUNCTION public.aa_wallet_convert_pack(p_batch uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b public.aa_batches; unused integer; amt bigint; res jsonb;
BEGIN
  SELECT * INTO b FROM public.aa_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF b.rate_paise IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'wallet_batch'); END IF;
  IF b.purchased_at IS NULL OR b.status IN ('pending_payment','refund_due','refunding','refunded') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_convertible');
  END IF;
  IF EXISTS (SELECT 1 FROM public.aa_tasks WHERE batch_id = p_batch AND status IN ('claimed','running','waiting_code','submitting')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tasks_active');
  END IF;
  unused := GREATEST(b.credits_total - b.credits_used, 0);
  IF unused = 0 OR b.price_paise <= 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'nothing_to_convert'); END IF;
  amt := (b.price_paise::bigint * unused) / b.credits_total;
  UPDATE public.aa_tasks SET status = 'cancelled', reason_code = 'pack_converted'
   WHERE batch_id = p_batch AND status IN ('shortlisted','queued');
  res := public.aa_wallet_adjust(b.user_id, amt, 'migration', 'pack_credit:' || p_batch::text,
                                 'pack credits converted: ' || unused || ' x ' || (b.price_paise / b.credits_total) || ' paise');
  IF (res->>'applied')::boolean THEN
    UPDATE public.aa_batches
       SET credits_total = credits_used,
           status = CASE WHEN credits_used > 0 THEN 'completed' ELSE 'cancelled' END,
           closed_at = now(), closed_reason = 'converted_to_wallet'
     WHERE id = p_batch;
  END IF;
  RETURN jsonb_build_object('ok', true, 'converted_credits', unused, 'amount_paise', amt, 'duplicate', NOT (res->>'applied')::boolean);
END $$;

-- ── 6. the sql/27 "user confirms a verify_submission task" path charges the wallet for wallet batches ───────
CREATE OR REPLACE FUNCTION public.aa_confirm_submitted(p_task uuid, p_user uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t   public.aa_tasks%ROWTYPE;
  b   public.aa_batches%ROWTYPE;
  cap bigint;
  why text := NULL;
  wr  jsonb;
BEGIN
  SELECT * INTO t FROM public.aa_tasks WHERE id = p_task AND user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF t.status = 'applied' THEN
    RETURN jsonb_build_object('ok', true, 'already', true,
      'charged', EXISTS (SELECT 1 FROM public.aa_credit_ledger WHERE task_id = p_task AND reason = 'capture')
                 OR EXISTS (SELECT 1 FROM public.aa_wallet_ledger WHERE task_id = p_task AND kind = 'capture'));
  END IF;
  IF t.status <> 'needs_you' THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_state', 'status', t.status); END IF;

  UPDATE public.aa_tasks
     SET status = 'applied', submitted_at = now(), reason_code = NULL, reason_detail = NULL,
         claimed_by = NULL, claimed_at = NULL, lease_until = NULL
   WHERE id = p_task;

  SELECT * INTO b FROM public.aa_batches WHERE id = t.batch_id FOR UPDATE;
  IF NOT FOUND THEN
    why := 'batch_missing';
  ELSIF b.rate_paise IS NOT NULL THEN
    wr := public.aa_wallet_capture_core(t, b);
    IF (wr->>'captured')::boolean THEN cap := 1; ELSE why := NULLIF(wr->>'reason', ''); END IF;
  ELSIF b.status IN ('refund_due','refunding','refunded') THEN
    why := 'batch_' || b.status;
  ELSIF b.credits_used >= b.credits_total THEN
    why := 'batch_full';
  ELSE
    INSERT INTO public.aa_credit_ledger (user_id, batch_id, delta, reason, task_id)
    VALUES (t.user_id, t.batch_id, -1, 'capture', p_task)
    ON CONFLICT (task_id) WHERE reason = 'capture' DO NOTHING
    RETURNING id INTO cap;
    IF cap IS NOT NULL THEN
      UPDATE public.aa_batches
         SET credits_used = credits_used + 1,
             status = CASE WHEN status = 'cancelled' THEN status
                           WHEN credits_used + 1 >= credits_total THEN 'completed' ELSE status END
       WHERE id = t.batch_id;
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'charged', cap IS NOT NULL, 'reason', why);
END $$;
REVOKE ALL ON FUNCTION public.aa_confirm_submitted(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ── 7. grants ───────────────────────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.aa_wallet_topup(uuid, text, text, bigint, text)                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aa_wallet_start_batch(uuid, integer, integer, integer, integer, text[], integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aa_wallet_reserve(uuid, text)                                         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aa_wallet_release_task(uuid)                                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aa_wallet_capture(uuid, text)                                         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aa_wallet_sweep_holds(integer)                                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aa_wallet_close_batch(uuid, text, text)                               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aa_wallet_adjust(uuid, bigint, text, text, text)                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aa_wallet_convert_pack(uuid)                                          FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aa_wallet_topup(uuid, text, text, bigint, text)                    TO service_role;
GRANT EXECUTE ON FUNCTION public.aa_wallet_start_batch(uuid, integer, integer, integer, integer, text[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.aa_wallet_reserve(uuid, text)                                      TO service_role;
GRANT EXECUTE ON FUNCTION public.aa_wallet_release_task(uuid)                                       TO service_role;
GRANT EXECUTE ON FUNCTION public.aa_wallet_capture(uuid, text)                                      TO service_role;
GRANT EXECUTE ON FUNCTION public.aa_wallet_sweep_holds(integer)                                     TO service_role;
GRANT EXECUTE ON FUNCTION public.aa_wallet_close_batch(uuid, text, text)                            TO service_role;
GRANT EXECUTE ON FUNCTION public.aa_wallet_adjust(uuid, bigint, text, text, text)                   TO service_role;
GRANT EXECUTE ON FUNCTION public.aa_wallet_convert_pack(uuid)                                       TO service_role;

-- the narrow worker role (sql_pending/28b, 30) reserves / captures / releases through these functions only and
-- reads wallets for CLAIM_SQL's balance check; a separate scheduler role (if it is not the postgres owner)
-- sweeps and closes through them
DO $$
DECLARE r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aa_worker') THEN
    GRANT EXECUTE ON FUNCTION public.aa_wallet_reserve(uuid, text) TO aa_worker;
    GRANT EXECUTE ON FUNCTION public.aa_wallet_release_task(uuid) TO aa_worker;
    GRANT EXECUTE ON FUNCTION public.aa_wallet_capture(uuid, text) TO aa_worker;
    GRANT SELECT ON public.aa_wallets TO aa_worker;
    DROP POLICY IF EXISTS aa_worker_all ON public.aa_wallets;
    CREATE POLICY aa_worker_all ON public.aa_wallets FOR SELECT TO aa_worker USING (true);
  END IF;
  FOREACH r IN ARRAY ARRAY['aa_scheduler'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.aa_wallet_close_batch(uuid, text, text) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.aa_wallet_sweep_holds(integer) TO %I', r);
      EXECUTE format('GRANT SELECT ON public.aa_wallets TO %I', r);
    END IF;
  END LOOP;
END $$;

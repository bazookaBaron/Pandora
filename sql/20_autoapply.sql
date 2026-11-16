-- ============================================================================
-- 20_autoapply.sql — AutoApply: paid batches of automated job applications.
-- Idempotent. Run in the Supabase SQL Editor AFTER sql/06, sql/16.
--
-- WHO WRITES WHAT
--  • Express server (service role): aa_profiles, aa_answers, aa_batches (create/pay/cancel),
--    aa_credit_ledger ('purchase', 'refund'), aa_mail_events (inbound), aa_needs_you (resolve),
--    aa_portal_accounts (read + decrypt for the owner only).
--  • Python scheduler (direct Postgres, SUPABASE_DB_URL): aa_jobs, aa_tasks (shortlist/queue),
--    aa_batches (status moves), aa_user_rr.
--  • Python workers (direct Postgres): aa_tasks (claim/run/result), aa_credit_ledger ('capture'),
--    aa_tenant_budget, aa_portal_accounts, aa_needs_you (create), aa_mail_events (consume).
--  • Browser: SELECT own rows only (RLS). Never writes. Realtime on aa_tasks / aa_batches.
--
-- Contract for all of this: docs/autoapply-contract.md
-- ============================================================================

-- ── profiles ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.aa_profiles (
  user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  profile              jsonb NOT NULL DEFAULT '{}'::jsonb,   -- parsed resume: name, phone, location, skills, experience[], education[]
  prefs                jsonb NOT NULL DEFAULT '{}'::jsonb,   -- titles[], locations[], min_score, blocked_companies[], current_employer
  resume_path          text,                                  -- Supabase Storage path in bucket 'aa-resumes'
  email_mode           text NOT NULL DEFAULT 'inbox' CHECK (email_mode IN ('inbox','gmail_forward')),
  apply_alias          text UNIQUE,                           -- local part only, e.g. 'debopriyo.k7q2'
  contact_email        text,                                  -- user's real address, for forwarding recruiter mail
  review_before_apply  boolean NOT NULL DEFAULT true,
  consent_at           timestamptz,
  onboarding_done      boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ── per-user answers to standard / learned questions ───────────────────────
CREATE TABLE IF NOT EXISTS public.aa_answers (
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question_key  text NOT NULL,
  answer        text NOT NULL,
  source        text NOT NULL DEFAULT 'user' CHECK (source IN ('user','rule','model_approved')),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, question_key)
);

-- ── shared, user-free question bank (label -> how to answer from a profile) ──
CREATE TABLE IF NOT EXISTS public.aa_question_bank (
  id               bigserial PRIMARY KEY,
  norm_label       text NOT NULL,
  ats              text,
  options_hash     text,
  kind             text NOT NULL DEFAULT 'text',          -- text|select|radio|checkbox|date
  answer_template  text NOT NULL,                          -- e.g. '{answers.notice_period_days}' or a literal option
  hits             integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (norm_label, ats, options_hash)
);

-- ── shared job catalog for AutoApply (LinkedIn trace + board search) ────────
CREATE TABLE IF NOT EXISTS public.aa_jobs (
  job_key        text PRIMARY KEY,                         -- '<ats>:<board-or-tenant>:<job id>' as in hunter.db
  ats            text NOT NULL,                            -- greenhouse|lever|ashby|workday|oraclehcm|successfactors|smartrecruiters|icims|eightfold|phenom
  company        text NOT NULL,
  company_key    text NOT NULL,                            -- normalised company name, used for per-company limits
  company_kind   text NOT NULL DEFAULT 'unknown' CHECK (company_kind IN ('product','service','unknown')),
  title          text NOT NULL,
  location       text,
  country        text,                                     -- ISO-2, e.g. 'IN'
  url            text,
  apply_url      text,
  tenant_host    text NOT NULL,                            -- host the application is submitted on (site budget key)
  source         text NOT NULL CHECK (source IN ('linkedin','boards','top','watchlist')),
  linkedin_id    text,
  posted_at      timestamptz,                              -- best known posting time
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz,
  description    text,
  job_json       jsonb NOT NULL DEFAULT '{}'::jsonb        -- the dict ats.apply_job expects
);
CREATE INDEX IF NOT EXISTS idx_aa_jobs_open_recent ON public.aa_jobs (company_kind, posted_at DESC) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_aa_jobs_company ON public.aa_jobs (company_key);

-- ── batches (one per purchased pack) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.aa_batches (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pack_kind            text NOT NULL CHECK (pack_kind IN ('service','product')),
  pack_size            integer NOT NULL CHECK (pack_size IN (50,80,100)),
  price_paise          integer NOT NULL,
  currency             text NOT NULL DEFAULT 'INR',
  window_days          integer NOT NULL DEFAULT 30 CHECK (window_days BETWEEN 1 AND 30),
  status               text NOT NULL DEFAULT 'pending_payment' CHECK (status IN (
                         'pending_payment','paid','shortlisting','review','running','paused',
                         'waiting_supply','completed','expired','refund_due','refunded','cancelled')),
  credits_total        integer NOT NULL,
  credits_used         integer NOT NULL DEFAULT 0,
  razorpay_order_id    text UNIQUE,
  razorpay_payment_id  text UNIQUE,
  refund_paise         integer,
  razorpay_refund_id   text,
  review_until         timestamptz,
  purchased_at         timestamptz,
  expires_at           timestamptz,                         -- purchased_at + 90 days
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aa_batches_user ON public.aa_batches (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aa_batches_status ON public.aa_batches (status);

-- ── credit ledger (append-only; balance per batch = SUM(delta)) ────────────
CREATE TABLE IF NOT EXISTS public.aa_credit_ledger (
  id                   bigserial PRIMARY KEY,
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  batch_id             uuid NOT NULL REFERENCES public.aa_batches(id) ON DELETE CASCADE,
  delta                integer NOT NULL,
  reason               text NOT NULL CHECK (reason IN ('purchase','capture','refund','expire','adjust')),
  task_id              uuid,
  razorpay_payment_id  text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_aa_ledger_purchase ON public.aa_credit_ledger (batch_id) WHERE reason = 'purchase';
CREATE UNIQUE INDEX IF NOT EXISTS uq_aa_ledger_capture ON public.aa_credit_ledger (task_id) WHERE reason = 'capture';

-- ── tasks (one per job per user) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.aa_tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id         uuid NOT NULL REFERENCES public.aa_batches(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_key          text NOT NULL REFERENCES public.aa_jobs(job_key),
  company          text NOT NULL,
  company_key      text NOT NULL,
  title            text NOT NULL,
  ats              text NOT NULL,
  tenant_host      text NOT NULL,
  apply_url        text,
  score            integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'shortlisted' CHECK (status IN (
                     'shortlisted','removed','queued','claimed','running','waiting_code','submitting',
                     'applied','skipped','failed','needs_you','cancelled')),
  attempt          integer NOT NULL DEFAULT 0,
  reason_code      text,
  reason_detail    text,
  claimed_by       text,
  claimed_at       timestamptz,
  lease_until      timestamptz,
  not_before       timestamptz NOT NULL DEFAULT now(),
  submitted_at     timestamptz,
  evidence         jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifacts_prefix text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_key)
);
CREATE INDEX IF NOT EXISTS idx_aa_tasks_runnable ON public.aa_tasks (not_before) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_aa_tasks_batch ON public.aa_tasks (batch_id, status);
CREATE INDEX IF NOT EXISTS idx_aa_tasks_user_active ON public.aa_tasks (user_id)
  WHERE status IN ('claimed','running','waiting_code','submitting');
CREATE INDEX IF NOT EXISTS idx_aa_tasks_user_applied ON public.aa_tasks (user_id, submitted_at) WHERE status = 'applied';
CREATE INDEX IF NOT EXISTS idx_aa_tasks_tenant_day ON public.aa_tasks (tenant_host, submitted_at) WHERE status = 'applied';

-- ── fairness cursor ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.aa_user_rr (
  user_id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  last_served_at  timestamptz NOT NULL DEFAULT 'epoch'
);

-- ── platform-wide per-site budget ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.aa_tenant_budget (
  tenant_host  text NOT NULL,
  day          date NOT NULL,                              -- IST calendar day
  daily_cap    integer NOT NULL DEFAULT 150,
  submitted    integer NOT NULL DEFAULT 0,
  captcha      integer NOT NULL DEFAULT 0,
  blocked      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_host, day)
);

-- ── portal accounts the bot created (secret = AES-256-GCM, see contract) ────
CREATE TABLE IF NOT EXISTS public.aa_portal_accounts (
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_host        text NOT NULL,
  login_email        text NOT NULL,
  secret_ciphertext  text NOT NULL,                        -- base64(nonce[12] || ciphertext || tag[16])
  storage_state_ref  text,                                 -- R2 key of encrypted Playwright storage_state
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending_verify','locked','user_supplied')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  PRIMARY KEY (user_id, tenant_host)
);

-- ── inbound mail to apply aliases ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.aa_mail_events (
  id                bigserial PRIMARY KEY,
  user_id           uuid REFERENCES auth.users(id) ON DELETE CASCADE,   -- NULL = unknown alias
  alias             text NOT NULL,                         -- full local part the mail was sent to
  sender            text NOT NULL,
  subject           text,
  codes             text[] NOT NULL DEFAULT '{}',
  links             text[] NOT NULL DEFAULT '{}',
  is_human          boolean NOT NULL DEFAULT false,
  text_excerpt      text,
  raw_ref           text,                                  -- R2 key
  received_at       timestamptz NOT NULL DEFAULT now(),
  consumed_by_task  uuid,
  forwarded_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_aa_mail_user_recent ON public.aa_mail_events (user_id, received_at DESC);

-- ── needs-you items ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.aa_needs_you (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      uuid NOT NULL REFERENCES public.aa_tasks(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('captcha','question','sso','account','other')),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,         -- {apply_url, question, options, suggestion, note}
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolution   text CHECK (resolution IN ('done_by_user','answered','dismissed','expired'))
);
CREATE INDEX IF NOT EXISTS idx_aa_needs_you_open ON public.aa_needs_you (user_id) WHERE resolved_at IS NULL;

-- ── monthly usage (IST month) ───────────────────────────────────────────────
CREATE OR REPLACE VIEW public.aa_usage_month AS
SELECT u.user_id,
       date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date AS month,
       COALESCE((SELECT SUM(b.credits_total) FROM public.aa_batches b
                 WHERE b.user_id = u.user_id AND b.purchased_at IS NOT NULL
                   AND date_trunc('month', b.purchased_at AT TIME ZONE 'Asia/Kolkata')
                     = date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')), 0) AS purchased,
       COALESCE((SELECT COUNT(*) FROM public.aa_tasks t
                 WHERE t.user_id = u.user_id AND t.status = 'applied'
                   AND date_trunc('month', t.submitted_at AT TIME ZONE 'Asia/Kolkata')
                     = date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')), 0) AS applied
FROM public.aa_profiles u;

-- ── notify waiting workers that mail arrived (called by the API via RPC) ────
CREATE OR REPLACE FUNCTION public.aa_notify_mail(p_user uuid, p_event bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT pg_notify('aa_mail', p_user::text || ':' || p_event::text);
$$;
REVOKE ALL ON FUNCTION public.aa_notify_mail(uuid, bigint) FROM PUBLIC, anon, authenticated;

-- ── updated_at triggers (touch_updated_at from sql/06) ──────────────────────
DROP TRIGGER IF EXISTS trg_aa_profiles_touch ON public.aa_profiles;
CREATE TRIGGER trg_aa_profiles_touch BEFORE UPDATE ON public.aa_profiles FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS trg_aa_batches_touch ON public.aa_batches;
CREATE TRIGGER trg_aa_batches_touch BEFORE UPDATE ON public.aa_batches FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS trg_aa_tasks_touch ON public.aa_tasks;
CREATE TRIGGER trg_aa_tasks_touch BEFORE UPDATE ON public.aa_tasks FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── RLS: owners read their own rows; nobody but the service role writes ────
ALTER TABLE public.aa_profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aa_answers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aa_question_bank   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aa_jobs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aa_batches         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aa_credit_ledger   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aa_tasks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aa_user_rr         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aa_tenant_budget   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aa_portal_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aa_mail_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aa_needs_you       ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['aa_profiles','aa_answers','aa_batches','aa_credit_ledger','aa_tasks','aa_mail_events','aa_needs_you']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_own', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (user_id = auth.uid())', t || '_select_own', t);
  END LOOP;
END $$;
-- aa_question_bank, aa_jobs, aa_user_rr, aa_tenant_budget, aa_portal_accounts: no policies = no client access.

-- ── storage bucket for resumes (private) ────────────────────────────────────
INSERT INTO storage.buckets (id, name, public) VALUES ('aa-resumes', 'aa-resumes', false)
ON CONFLICT (id) DO NOTHING;

-- ── realtime for live progress ──────────────────────────────────────────────
DO $$
BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.aa_tasks;   EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.aa_batches; EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

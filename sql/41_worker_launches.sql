-- 41_worker_launches.sql — on-demand Vast worker launches (contract: AutoJobApplier
-- cloud_hunter/saas/deploy/WORKER_CONTRACT.md). Written by aa-control (postgres role), read/updated by the
-- Pandora broker (service role). RLS on, no policies: never visible to anon / authenticated.
--
-- db_dsn_enc / mail_dsn_enc: 'v1:' || base64(iv12 || ciphertext || tag16), AES-256-GCM,
-- key = base64-decoded AA_BROKER_KEY (32 bytes), AAD = launch id (utf-8).
-- bootstrap_hash / worker_token_hash: sha256 hex of the 32-byte base64url tokens (tokens are never stored).

CREATE TABLE IF NOT EXISTS public.aa_worker_launches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id          text NOT NULL UNIQUE,
  instance_id        bigint,
  bootstrap_hash     text NOT NULL CHECK (bootstrap_hash ~ '^[0-9a-f]{64}$'),
  bootstrap_used_at  timestamptz,
  worker_token_hash  text NOT NULL CHECK (worker_token_hash ~ '^[0-9a-f]{64}$'),
  db_dsn_enc         text NOT NULL CHECK (db_dsn_enc LIKE 'v1:%'),
  mail_dsn_enc       text NOT NULL CHECK (mail_dsn_enc LIKE 'v1:%'),
  status             text NOT NULL DEFAULT 'starting'
                       CHECK (status IN ('starting', 'running', 'stopping', 'stopped', 'failed')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL DEFAULT (now() + interval '12 hours'),
  stopped_at         timestamptz
);

CREATE INDEX IF NOT EXISTS ix_aa_worker_launches_active
  ON public.aa_worker_launches (status) WHERE status IN ('starting', 'running', 'stopping');

ALTER TABLE public.aa_worker_launches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.aa_worker_launches FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.aa_worker_launches TO service_role;

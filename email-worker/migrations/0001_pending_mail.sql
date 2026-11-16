-- Parked inbound mail payloads awaiting re-delivery (see README "Durable retry").
CREATE TABLE IF NOT EXISTS pending_mail (
  id              TEXT PRIMARY KEY,
  payload         TEXT NOT NULL,       -- the JSON body POSTed to the API (no raw .eml)
  created_at      INTEGER NOT NULL,    -- epoch ms; gives up 3 days after this
  next_attempt_at INTEGER NOT NULL,    -- epoch ms
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_due ON pending_mail (next_attempt_at);

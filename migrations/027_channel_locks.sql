-- migrations/027_channel_locks.sql
CREATE TABLE IF NOT EXISTS channel_locks (
  id BIGSERIAL PRIMARY KEY,
  whatsapp_number_id BIGINT NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  identifier TEXT NOT NULL,
  locked_by TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT channel_locks_uq UNIQUE (whatsapp_number_id, identifier)
);
CREATE INDEX IF NOT EXISTS idx_channel_locks_expiry ON channel_locks (expires_at);

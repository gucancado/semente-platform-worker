-- Padrão canônico de webhook externo: idempotente + replay + dead-letter.
-- v1: tabela + repo (handler Recall vem no 2º incremento).
CREATE TABLE webhook_receipts (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  claimed_by TEXT,
  last_error TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, external_event_id),
  CONSTRAINT webhook_receipts_status_chk CHECK (status IN ('received', 'processed', 'failed', 'dead'))
);
CREATE INDEX idx_webhook_receipts_due ON webhook_receipts (next_attempt_at) WHERE status IN ('received', 'failed');

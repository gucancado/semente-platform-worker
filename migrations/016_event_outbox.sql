-- Primitiva canônica de eventos do ecossistema (02 §2.3).
-- Evento = fato imutável; entregas = 1 row por assinante (status nunca compartilhado).
CREATE TABLE event_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  dispatched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_event_outbox_undispatched ON event_outbox (id) WHERE dispatched_at IS NULL;

CREATE TABLE event_outbox_deliveries (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES event_outbox(id),
  subscriber_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, subscriber_key),
  CONSTRAINT outbox_deliveries_status_chk CHECK (status IN ('pending', 'delivered', 'dead'))
);
CREATE INDEX idx_outbox_deliveries_due ON event_outbox_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX idx_outbox_deliveries_dead ON event_outbox_deliveries (created_at DESC) WHERE status = 'dead';

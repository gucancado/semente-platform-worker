-- Adiciona colunas em webhook_logs para servir como inbox do agente.
-- A partir da v0.6 da SPEC, o worker é a fila primária; Bloquim deixa
-- de ser dependência do caminho crítico.

ALTER TABLE webhook_logs
  ADD COLUMN IF NOT EXISTS instance TEXT,
  ADD COLUMN IF NOT EXISTS push_name TEXT,
  ADD COLUMN IF NOT EXISTS message_text TEXT,
  ADD COLUMN IF NOT EXISTS workspace_id TEXT,
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processed_by TEXT;

-- Index pra busca de inbox não-lida por agente (partial index, dados pequenos)
CREATE INDEX IF NOT EXISTS idx_webhook_logs_inbox_unread
  ON webhook_logs (agent, created_at)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_logs_instance
  ON webhook_logs (instance);

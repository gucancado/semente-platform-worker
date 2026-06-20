-- migrations/026_messages_whatsapp_columns.sql
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS whatsapp_number_id BIGINT REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE messages ALTER COLUMN agent DROP NOT NULL;

ALTER TABLE webhook_logs
  ADD COLUMN IF NOT EXISTS whatsapp_number_id BIGINT REFERENCES whatsapp_numbers(id) ON DELETE CASCADE;
-- webhook_logs.workspace_id já existe (migration 002); ADD IF NOT EXISTS é no-op seguro:
ALTER TABLE webhook_logs ADD COLUMN IF NOT EXISTS workspace_id TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_number_thread ON messages (whatsapp_number_id, identifier, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_workspace ON messages (workspace_id, created_at DESC);
-- Dedup pós-inversão (agent nullable em messages ⇒ dedup global por evento).
-- Purga defensiva ANTES do índice único (espelha migration 003): se houver evento
-- duplicado cross-agent no histórico, o CREATE UNIQUE INDEX abortaria e o deploy
-- quebraria. Mantém a linha mais antiga (menor id) por evolution_event_id.
DELETE FROM webhook_logs a USING webhook_logs b
 WHERE a.id > b.id
   AND a.evolution_event_id = b.evolution_event_id
   AND a.evolution_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_logs_evt ON webhook_logs (evolution_event_id) WHERE evolution_event_id IS NOT NULL;

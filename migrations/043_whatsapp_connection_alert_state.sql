-- migrations/043_whatsapp_connection_alert_state.sql
-- Estado do alerta de QUEDA de conexão. Ortogonal a `status` e a `removed_at`:
--   disconnected_since: setado quando o número transita DE 'connected' PARA outro
--     estado (queda real); NULL enquanto 'connected'. Numeros que NUNCA conectaram
--     (pending/connecting de provisioning) ficam com NULL → não geram alerta.
--   alerted_at: setado pelo sweep quando o alerta de queda já foi disparado (idempotência
--     por episódio); NULL enquanto 'connected'. Reconexão zera ambos.
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS disconnected_since TIMESTAMPTZ;
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS alerted_at TIMESTAMPTZ;

-- Índice parcial p/ o sweep (poucas linhas fora do ar por vez).
CREATE INDEX IF NOT EXISTS idx_whatsapp_numbers_pending_alert
  ON whatsapp_numbers (disconnected_since)
  WHERE status <> 'connected' AND removed_at IS NULL AND alerted_at IS NULL;

-- Dedup de webhooks: Evolution às vezes manda o mesmo evento duas vezes
-- (mesmo evolution_event_id) em curta janela após reconnect ou retry.
-- Índice único parcial garante no máximo 1 linha por (agent, evolution_event_id)
-- quando evolution_event_id está presente. Linhas de debug (channel='debug',
-- evolution_event_id NULL) ficam de fora.

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_logs_agent_event
  ON webhook_logs (agent, evolution_event_id)
  WHERE evolution_event_id IS NOT NULL;

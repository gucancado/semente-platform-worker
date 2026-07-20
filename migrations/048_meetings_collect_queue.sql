-- migrations/048_meetings_collect_queue.sql
-- 048: fila de slots da coleta Vexa (preparo multibot): status 'queued' + title
-- (propagado ao episódio no import) + expiração de fila (reunião que termina
-- sem conseguir slot vira failed/no_slot). O pedido de coleta nunca é rejeitado
-- por concorrência — entra na fila; o poller promove conforme slots livres.
ALTER TABLE collected_meetings DROP CONSTRAINT IF EXISTS collected_meetings_status_chk;
ALTER TABLE collected_meetings ADD CONSTRAINT collected_meetings_status_chk
  CHECK (status IN ('queued','collecting','stopping','imported','failed','canceled'));
ALTER TABLE collected_meetings ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE collected_meetings ADD COLUMN IF NOT EXISTS queue_expires_at TIMESTAMPTZ;
-- Índice parcial passa a cobrir a fila também.
DROP INDEX IF EXISTS idx_collected_meetings_active;
CREATE INDEX IF NOT EXISTS idx_collected_meetings_active
  ON collected_meetings (created_at) WHERE status IN ('queued','collecting','stopping');

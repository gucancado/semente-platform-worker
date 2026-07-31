-- migrations/056_ai_insights_unique_run.sql
-- CRM WhatsApp v3 — Fase E (Task E3 fix, BLOQUEADOR 1): "1 insight por run" vira INVARIANTE
-- DO BANCO. Sem isto, uma retomada da run semanal (claim de 'failed' que re-aplica a decisão
-- persistida) re-inseria um 2º whatsapp_ai_insights pro mesmo run_id — o dashboard mostraria
-- o insight da semana em dobro. O índice é PARCIAL (só run_id NOT NULL): insights avulsos
-- (run_id NULL, caminho defensivo) convivem sem restrição. insertInsight passa a usar
-- ON CONFLICT (run_id) WHERE run_id IS NOT NULL DO NOTHING (retorna null no conflito).
--
-- lock_timeout curto: mesmo racional das 051/055 (falha rápido se a tabela estiver sob lock
-- no boot; o runner de migrations re-tenta no próximo deploy). Primeiro statement, sem
-- BEGIN/COMMIT próprio — o runner (src/migrate.ts) já envolve o arquivo numa transação.
SET LOCAL lock_timeout = '10s';

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_insights_run
  ON whatsapp_ai_insights (run_id) WHERE run_id IS NOT NULL;

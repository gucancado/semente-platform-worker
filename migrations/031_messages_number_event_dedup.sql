-- migrations/031_messages_number_event_dedup.sql
-- Dedup de `messages` por NÚMERO (não global). O dedup global de webhook_logs
-- (uq_webhook_logs_evt) faz a mesma mensagem vista por 2 números do mesmo worker
-- colidir e ser descartada de um dos lados. messages passa a deduplicar por
-- (whatsapp_number_id, evolution_event_id) — cada número grava sua própria cópia.

-- Defensiva (padrão das migrações 026/030): remove duplicatas (whatsapp_number_id, evolution_event_id)
-- antes do índice único, mantendo a linha mais antiga (menor id).
DELETE FROM messages a
 USING messages b
 WHERE a.whatsapp_number_id IS NOT NULL
   AND a.evolution_event_id IS NOT NULL
   AND a.whatsapp_number_id = b.whatsapp_number_id
   AND a.evolution_event_id = b.evolution_event_id
   AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_number_event
  ON messages (whatsapp_number_id, evolution_event_id)
  WHERE whatsapp_number_id IS NOT NULL AND evolution_event_id IS NOT NULL;

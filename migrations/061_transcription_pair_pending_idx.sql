-- 061_transcription_pair_pending_idx.sql
--
-- Índice para o predicado novo do PENDING_SQL do julgamento IA: "esta conversa
-- tem áudio ainda na fila?" (src/whatsapp/ai-judgment-runner.ts). Sem ele, cada
-- conversa candidata do sweep dispara um scan em transcription_jobs.
--
-- Parcial em status='pending' de propósito: a tabela acumula milhares de linhas
-- 'done' que a consulta nunca olha, e o índice parcial fica pequeno o bastante
-- pra viver em cache. Espelha idx_transcription_jobs_due, que já usa a mesma
-- estratégia para o claim do poller.

CREATE INDEX IF NOT EXISTS idx_transcription_jobs_pair_pending
  ON transcription_jobs (whatsapp_number_id, identifier)
  WHERE status = 'pending';

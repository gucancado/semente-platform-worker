-- migrations/054_whatsapp_ai_judgments.sql
-- CRM WhatsApp v3 — Fase D: auditoria + watermark do julgamento IA nível 1 (spec
-- beeads-central-de-dados/docs/superpowers/specs/2026-07-29-crm-whatsapp-v3-kanban-ia-design.md §3.2, §7).
--
-- Cada row = uma decisão do motor de IA (nível 1) sobre uma conversa. `decision` é o
-- output bruto do LLM (pós-validação); `applied` é o que de fato foi escrito
-- (pós-sticky/invariantes). `input_last_message_at` é o WATERMARK — a última mensagem
-- considerada no input. O UNIQUE (número, identifier, input_last_message_at) dá
-- idempotência: um retry pós-crash NÃO re-julga o mesmo input, e o aplicador (D4,
-- ai-judgment-apply.ts) usa o INSERT ... ON CONFLICT DO NOTHING como CLAIM (primeiro
-- statement de escrita, ANTES de qualquer mutação) — conflito = já julgado, aborta sem
-- aplicar nada.

-- lock_timeout curto: mesmo racional das 051/053 (falha rápido se a tabela estiver sob
-- lock no boot; o runner re-tenta no próximo deploy). Primeiro statement, sem BEGIN/COMMIT
-- próprio — o runner (src/migrate.ts) já envolve o arquivo inteiro numa transação.
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS whatsapp_ai_judgments (
  id                    BIGSERIAL PRIMARY KEY,
  whatsapp_number_id    BIGINT NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  identifier            TEXT NOT NULL,
  workspace_id          TEXT NOT NULL,
  decided_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  input_last_message_at TIMESTAMPTZ NOT NULL,     -- watermark: última msg considerada
  decision              JSONB NOT NULL,           -- output bruto do LLM (pós-validação)
  applied               JSONB NOT NULL,           -- o que foi de fato aplicado (pós-sticky/invariantes)
  rationale             TEXT,
  model                 TEXT
);

-- Leitura por conversa em ordem cronológica reversa (watermark do runner: maior
-- input_last_message_at do par; auditoria/timeline).
CREATE INDEX IF NOT EXISTS idx_ai_judgments_pair_decided
  ON whatsapp_ai_judgments (whatsapp_number_id, identifier, decided_at DESC);

-- Idempotência: retry pós-crash não julga o mesmo input 2x; suporta o CLAIM do aplicador.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_judgment_watermark
  ON whatsapp_ai_judgments (whatsapp_number_id, identifier, input_last_message_at);

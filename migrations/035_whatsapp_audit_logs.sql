-- migrations/035_whatsapp_audit_logs.sql
-- Audit trail de acesso (LGPD art. 37 — registro de operações de tratamento de dados).
-- Retém logs mesmo que o número seja removido; por isso number_id NÃO tem FK,
-- apenas é armazenado como referência histórica. Isso é intencional: quem leu
-- os dados de um número deletado ainda deve ser auditável.

-- ── Tabela 1: log de acesso a dados sensíveis ───────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_access_log (
  id           BIGSERIAL    PRIMARY KEY,
  actor        TEXT         NOT NULL,
  action       TEXT         NOT NULL,
  workspace_id TEXT,
  number_id    BIGINT,       -- sem FK: log persiste após deleção do número
  identifier   TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  meta         JSONB
);

-- Índice primário de auditoria: workspace × tempo
CREATE INDEX IF NOT EXISTS whatsapp_access_log_ws_created
  ON whatsapp_access_log (workspace_id, created_at);

-- ── Tabela 2: log de transições de campo por-thread ─────────────────────────
-- Registra old_value → new_value por campo (ex.: is_lead). Vinculado ao número
-- via FK (número deletado → ON DELETE CASCADE: fine, pois o número em si some).
CREATE TABLE IF NOT EXISTS whatsapp_thread_meta_log (
  id                  BIGSERIAL    PRIMARY KEY,
  whatsapp_number_id  BIGINT       NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  identifier          TEXT         NOT NULL,
  field               TEXT         NOT NULL,
  old_value           TEXT,
  new_value           TEXT,
  actor               TEXT         NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Índice para consulta de histórico de uma thread
CREATE INDEX IF NOT EXISTS whatsapp_thread_meta_log_num_id_created
  ON whatsapp_thread_meta_log (whatsapp_number_id, identifier, created_at);

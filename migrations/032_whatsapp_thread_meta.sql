-- migrations/032_whatsapp_thread_meta.sql
-- Metadados por-thread (overrides). Threads seguem derivadas de messages; esta
-- tabela só guarda estado de curadoria (lead) por (numero, identifier).
CREATE TABLE IF NOT EXISTS whatsapp_thread_meta (
  whatsapp_number_id BIGINT      NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  identifier         TEXT        NOT NULL,
  is_lead            BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         TEXT,
  PRIMARY KEY (whatsapp_number_id, identifier)
);

-- Exposição de grupos no MCP (hard-gate, MCP-only). Default OFF: só DMs no MCP.
ALTER TABLE whatsapp_numbers
  ADD COLUMN IF NOT EXISTS expose_groups_in_mcp BOOLEAN NOT NULL DEFAULT FALSE;

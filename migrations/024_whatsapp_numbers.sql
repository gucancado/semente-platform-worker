-- migrations/024_whatsapp_numbers.sql
CREATE TABLE IF NOT EXISTS whatsapp_numbers (
  id BIGSERIAL PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT 'whatsapp_numero_v1',
  workspace_id TEXT NOT NULL,
  phone TEXT,
  evolution_instance TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  mode TEXT NOT NULL DEFAULT 'monitored',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wn_status_chk CHECK (status IN ('pending','connecting','connected','disconnected')),
  CONSTRAINT wn_mode_chk CHECK (mode IN ('monitored','agent_operated')),
  CONSTRAINT wn_instance_uq UNIQUE (evolution_instance)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_numbers_workspace ON whatsapp_numbers (workspace_id, status);

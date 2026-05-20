-- semente-worker-postgres — schema inicial
-- Documentação: SPEC §10.5 (plataforma Semente)

CREATE TABLE IF NOT EXISTS contact_routes (
  id BIGSERIAL PRIMARY KEY,
  agent TEXT NOT NULL,
  channel TEXT NOT NULL,                   -- 'whatsapp' | 'email'
  identifier TEXT NOT NULL,                -- E.164 ou email
  workspace_id TEXT NOT NULL,
  display_name TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent, channel, identifier)
);

CREATE INDEX IF NOT EXISTS idx_contact_routes_lookup
  ON contact_routes (agent, channel, identifier);

CREATE INDEX IF NOT EXISTS idx_contact_routes_by_workspace
  ON contact_routes (agent, workspace_id);

CREATE TABLE IF NOT EXISTS webhook_logs (
  id BIGSERIAL PRIMARY KEY,
  agent TEXT NOT NULL,
  channel TEXT NOT NULL,
  identifier TEXT,
  evolution_event_id TEXT,
  payload_summary TEXT,
  bloquim_task_id TEXT,
  fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_agent_time
  ON webhook_logs (agent, created_at DESC);

-- Trigger para updated_at em contact_routes
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS contact_routes_updated_at ON contact_routes;
CREATE TRIGGER contact_routes_updated_at
  BEFORE UPDATE ON contact_routes
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- migrations/025_workspace_agents.sql
CREATE TABLE IF NOT EXISTS workspace_agents (
  id BIGSERIAL PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT 'workspace_agent_v1',
  workspace_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config JSONB NOT NULL DEFAULT '{}',
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wa_uq UNIQUE (workspace_id, agent)
);
CREATE INDEX IF NOT EXISTS idx_workspace_agents_lookup ON workspace_agents (workspace_id) WHERE enabled;

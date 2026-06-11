-- Atribuição reunião→workspace por domínio de e-mail dos participantes.
-- PK global em domain: mesmo domínio em 2 workspaces = ambiguidade real,
-- deve falhar alto (decisão consciente, spec §9 / pauta item 4).
CREATE TABLE workspace_domains (
  domain TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_slug TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

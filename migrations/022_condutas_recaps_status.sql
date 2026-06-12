-- Condutas (conduta_v1): memória procedural, 1 documento versionado por workspace.
CREATE TABLE condutas (
  id BIGSERIAL PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT 'conduta_v1',
  workspace_id TEXT NOT NULL,
  version INT NOT NULL,                  -- monotônico por workspace, começa em 1
  status TEXT NOT NULL DEFAULT 'proposed',
  content_md TEXT NOT NULL,              -- documento inteiro renderizado (o que é injetado)
  proposed_by TEXT NOT NULL DEFAULT 'lua',  -- 'lua' | 'human:<identificador>'
  approval_task_id TEXT,                 -- id da tarefa de aprovação no Bloquim (portão 03 §4)
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  rejection_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT condutas_status_chk CHECK (status IN ('proposed', 'active', 'rejected', 'superseded')),
  UNIQUE (workspace_id, version)
);
-- invariantes: no máximo 1 ativa e 1 proposta por workspace
CREATE UNIQUE INDEX idx_condutas_one_active ON condutas (workspace_id) WHERE status = 'active';
CREATE UNIQUE INDEX idx_condutas_one_proposed ON condutas (workspace_id) WHERE status = 'proposed';

-- Regras individuais: proveniência POR REGRA (03 §6 — "cada regra aponta aos episódios").
CREATE TABLE conduta_rules (
  id BIGSERIAL PRIMARY KEY,
  conduta_id BIGINT NOT NULL REFERENCES condutas(id) ON DELETE CASCADE,
  rule_index INT NOT NULL,
  text TEXT NOT NULL,
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,  -- setado quando fato-fonte muda (§4.6, §6.5)
  UNIQUE (conduta_id, rule_index)
);

-- Regra → fatos que a justificam (fato → episódio fecha a cadeia de proveniência).
CREATE TABLE conduta_rule_sources (
  rule_id BIGINT NOT NULL REFERENCES conduta_rules(id) ON DELETE CASCADE,
  fact_id BIGINT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  PRIMARY KEY (rule_id, fact_id)
);

-- Recaps (recap_v1): narradora mínima, 1 por workspace por semana.
CREATE TABLE recaps (
  id BIGSERIAL PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT 'recap_v1',
  workspace_id TEXT NOT NULL,
  period_start DATE NOT NULL,            -- segunda-feira (semana ISO)
  period_end DATE NOT NULL,              -- domingo
  content_md TEXT NOT NULL,
  model TEXT NOT NULL,
  run_id BIGINT REFERENCES lua_runs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, period_start)    -- idempotência: re-rodar a noite não duplica
);

CREATE TABLE recap_sources (
  recap_id BIGINT NOT NULL REFERENCES recaps(id) ON DELETE CASCADE,
  episode_id BIGINT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  PRIMARY KEY (recap_id, episode_id)
);

-- Status descritivo do projeto (status_v1): poucas frases, objetivo, sempre atual.
-- Append-only: linha mais recente por workspace = status vigente; histórico fica.
CREATE TABLE project_status (
  id BIGSERIAL PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT 'status_v1',
  workspace_id TEXT NOT NULL,
  content_md TEXT NOT NULL,              -- 3-6 frases, descritivo, sem narrativa
  model TEXT NOT NULL,
  run_id BIGINT REFERENCES lua_runs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_project_status_latest ON project_status (workspace_id, created_at DESC);

CREATE TABLE project_status_sources (
  status_id BIGINT NOT NULL REFERENCES project_status(id) ON DELETE CASCADE,
  fact_id BIGINT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  PRIMARY KEY (status_id, fact_id)
);

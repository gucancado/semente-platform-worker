-- Configuração por (agent, project). Hoje só carrega quiet_hours (Fase 3 da
-- mitigação anti-detecção), mas a tabela é desenhada pra crescer com outros
-- toggles operacionais por projeto (rate limits específicos, defaults de tom,
-- etc.) sem precisar de nova migration.
--
-- Sem FK pra catálogo de agentes/projetos porque eles vivem em outros lugares
-- (env JSON do worker, repo do agente). PRIMARY KEY (agent, project) é a
-- garantia de unicidade.

CREATE TABLE IF NOT EXISTS agent_project_config (
  agent TEXT NOT NULL,
  project TEXT NOT NULL,

  -- Quiet hours: agente não responde dentro dessa janela. Burst smoothing
  -- enfileira msgs do quiet pra responder 1x no fim da janela.
  quiet_hours_enabled BOOLEAN NOT NULL DEFAULT false,
  quiet_start TIME NOT NULL DEFAULT '23:00',
  quiet_end TIME NOT NULL DEFAULT '07:00',
  quiet_tz TEXT NOT NULL DEFAULT 'America/Sao_Paulo',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (agent, project)
);

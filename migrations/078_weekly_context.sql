-- Resumo semanal de contexto por cliente (Visão Geral do painel, tática semanal).
-- Um resumo por (workspace, semana). A semana é identificada pela segunda-feira
-- (dia civil de São Paulo) em que o resumo passa a valer: o gerador roda a partir
-- de domingo 20h e grava a semana que começa no dia seguinte. Gerar de novo a
-- mesma semana substitui a linha (upsert).
--
-- status: 'ok' = texto gerado; 'empty' = sem mensagem de grupo nem reunião no
-- período (nenhuma chamada de LLM); 'failed' = a chamada falhou (o poller tenta de
-- novo depois de 1h). O custo também vai para llm_metrics (task weekly_context).
CREATE TABLE IF NOT EXISTS weekly_context_summaries (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  week_start    DATE NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'empty', 'failed')),
  summary       TEXT,
  provider      TEXT,
  model         TEXT,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  cost_usd      NUMERIC(10, 6),
  sources       JSONB,
  error         TEXT,
  generated_by  TEXT,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_weekly_context_ws_week
  ON weekly_context_summaries (workspace_id, week_start DESC);

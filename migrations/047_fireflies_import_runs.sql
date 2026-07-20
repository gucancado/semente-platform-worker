-- 047: coleta contínua Fireflies — ledger/claim diário do cron de import.
-- A INSERÇÃO é o claim (UNIQUE run_date + ON CONFLICT DO NOTHING), espelhando
-- o padrão de lua_runs (1 run nightly por data). Réplicas concorrentes nunca
-- duplicam o dia porque a unicidade é do banco, não de leitura-antes-do-write.
CREATE TABLE IF NOT EXISTS fireflies_import_runs (
  id BIGSERIAL PRIMARY KEY,
  run_date DATE NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  stats JSONB,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- migrations/055_crm_v3_pattern_tables.sql
-- CRM WhatsApp v3 — Fase E: motor de IA nível 2 (análise semanal de padrões) — spec
-- beeads-central-de-dados/docs/superpowers/specs/2026-07-29-crm-whatsapp-v3-kanban-ia-design.md §3.2, §8.
--
-- Três tabelas novas (DDL exato do §3.2):
--  - whatsapp_ai_pattern_runs: 1 row por (workspace, semana) — claim via INSERT ON CONFLICT
--    DO NOTHING (molde `claimNight`, src/lua/db.ts). status='failed' é retomável (E1 store:
--    claimPatternRun re-tenta a mesma row); 'running'/'done' bloqueiam nova tentativa.
--  - whatsapp_ai_suggestions: nível 2 → humano (edição de guidance). NUNCA aplicado
--    automaticamente — índice único parcial uq_ai_suggestions_pending (workspace, kind)
--    WHERE status='pending' garante no máximo 1 pendente por kind/workspace, mesmo sob
--    corrida (fast-path em código + fallback em 23505, ver comentário na tabela abaixo).
--  - whatsapp_ai_insights: relatório semanal (texto curto + jsonb de detalhes),
--    referencia o run que o produziu.
--
-- lock_timeout curto: mesmo racional das 051/053/054 (falha rápido se alguma tabela
-- estiver sob lock no boot; o runner re-tenta no próximo deploy). Primeiro statement,
-- sem BEGIN/COMMIT próprio — o runner (src/migrate.ts) já envolve o arquivo inteiro
-- numa transação.
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS whatsapp_ai_pattern_runs (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  output       JSONB
);

-- Claim: INSERT ... ON CONFLICT (workspace_id, period_start) DO NOTHING RETURNING id
-- (molde `claimNight`). Idempotência semanal por workspace.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_pattern_runs ON whatsapp_ai_pattern_runs (workspace_id, period_start);

CREATE TABLE IF NOT EXISTS whatsapp_ai_suggestions (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('guidance_lead','guidance_qualified')),
  payload      JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','dismissed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  TEXT
);

-- Dedupe (nível 2 não cria 2ª sugestão pending do mesmo kind no workspace) tem DUAS
-- camadas: fast-path em código (INSERT ... WHERE NOT EXISTS, src/whatsapp/
-- ai-pattern-store.ts) + a garantia de verdade abaixo — índice único PARCIAL (só sobre
-- status='pending'; aplicada/dispensada convivem livremente com uma nova pendente,
-- então a unicidade não pode ser sobre a tabela inteira). Fecha a corrida em que duas
-- chamadas passam AMBAS pelo NOT EXISTS antes de qualquer uma commitar — a 2ª leva
-- unique_violation (23505), tratado no store como dedupe (retorna null).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_suggestions_pending
  ON whatsapp_ai_suggestions (workspace_id, kind) WHERE status = 'pending';

-- Índice geral (todos os status) pra listagens/filtros que não se restringem a pending.
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_ws_kind_status
  ON whatsapp_ai_suggestions (workspace_id, kind, status);

CREATE TABLE IF NOT EXISTS whatsapp_ai_insights (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id       BIGINT REFERENCES whatsapp_ai_pattern_runs(id),
  run_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  summary      TEXT NOT NULL,
  details      JSONB
);

CREATE INDEX IF NOT EXISTS idx_ai_insights_ws_run_at ON whatsapp_ai_insights (workspace_id, run_at DESC);

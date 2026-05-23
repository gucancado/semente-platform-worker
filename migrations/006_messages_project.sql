-- Sub-tarefa A do projeto agentes-beeads:
-- Adiciona coluna `project` em messages pra permitir filtros por projeto
-- (ex: stats por persona "metido-a-gente" do agente "mercurio").
--
-- Aditiva e nullable: rows antigas ficam NULL até backfill (migration 007).
-- Novas rows são preenchidas pelo parser (inbound) e pelo tick.sh (outbound).

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS project TEXT;

-- Índice composto cobre a query mais comum da console:
-- "stats das últimas 24h do projeto X do agente Y".
CREATE INDEX IF NOT EXISTS idx_messages_agent_project_created
  ON messages (agent, project, created_at DESC)
  WHERE project IS NOT NULL;

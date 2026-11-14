-- Custo de IA por workspace, número de WhatsApp e reunião.
--
-- Até aqui llm_metrics só sabia agente/modelo/custo: dava o gasto total, nunca
-- o de um cliente. As três colunas são preenchidas por quem grava a métrica
-- (julgamento e análise semanal do CRM, transcrição de áudio, digest e
-- recuperação de reunião) e lidas pelo painel (dashboard do WhatsApp e página
-- da reunião).
--
-- whatsapp_number_id NULO com workspace_id preenchido = custo do workspace
-- inteiro (análise semanal do CRM), não de um número.
ALTER TABLE llm_metrics ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE llm_metrics ADD COLUMN IF NOT EXISTS whatsapp_number_id BIGINT;
ALTER TABLE llm_metrics ADD COLUMN IF NOT EXISTS episode_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_llm_metrics_workspace
  ON llm_metrics (workspace_id, created_at) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_llm_metrics_episode
  ON llm_metrics (episode_id) WHERE episode_id IS NOT NULL;

-- ── Histórico ────────────────────────────────────────────────────────────────
-- Transcrição de áudio: vínculo exato pela mensagem.
UPDATE llm_metrics l
   SET workspace_id = m.workspace_id, whatsapp_number_id = m.whatsapp_number_id
  FROM messages m
 WHERE l.message_id = m.id AND l.workspace_id IS NULL AND l.agent = 'transcription';

-- Julgamento do CRM (nível 1): o runner é SERIAL e grava a métrica logo antes do
-- julgamento. Intercalando os dois fluxos no tempo, cada julgamento pertence à
-- última métrica anterior a ele; vale só o 1º julgamento após a métrica e a menos
-- de 2 min dela. Métrica sem julgamento depois (já julgada, erro) fica sem vínculo.
WITH ev AS (
  SELECT 'm' AS k, l.id, l.created_at AS ts, NULL::text AS ws, NULL::bigint AS num
    FROM llm_metrics l WHERE l.agent = 'crm-ai-judgment' AND l.workspace_id IS NULL
  UNION ALL
  SELECT 'j', j.id, j.decided_at, j.workspace_id, j.whatsapp_number_id
    FROM whatsapp_ai_judgments j
), tagged AS (
  SELECT ev.*,
         max(CASE WHEN k = 'm' THEN id END) OVER w AS metric_id,
         max(CASE WHEN k = 'm' THEN ts END) OVER w AS metric_ts
    FROM ev
  WINDOW w AS (ORDER BY ts, k DESC, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
), firsts AS (
  SELECT DISTINCT ON (metric_id) metric_id, ws, num
    FROM tagged
   WHERE k = 'j' AND metric_id IS NOT NULL AND ts - metric_ts < interval '2 minutes'
   ORDER BY metric_id, ts
)
UPDATE llm_metrics l SET workspace_id = f.ws, whatsapp_number_id = f.num
  FROM firsts f WHERE l.id = f.metric_id;

-- Análise semanal (nível 2): a métrica cai dentro da janela da run do workspace.
UPDATE llm_metrics l SET workspace_id = r.workspace_id
  FROM whatsapp_ai_pattern_runs r
 WHERE l.agent = 'crm-ai-pattern' AND l.workspace_id IS NULL
   AND l.created_at >= r.started_at
   AND l.created_at <= COALESCE(r.finished_at, r.started_at + interval '1 hour');

-- Digest de reunião: o poller também é serial e grava a métrica antes de salvar o
-- digest. Só a geração que VALEU tem marca no episódio (summary_generated_at), então
-- tentativas anteriores do mesmo episódio ficam sem vínculo (custo subcontado).
WITH ev AS (
  SELECT 'm' AS k, l.id, l.created_at AS ts, NULL::bigint AS ep, NULL::text AS ws
    FROM llm_metrics l WHERE l.task = 'meeting_summary' AND l.episode_id IS NULL
  UNION ALL
  SELECT 'e', e.id, e.summary_generated_at, e.id, e.workspace_id
    FROM episodes e WHERE e.summary_generated_at IS NOT NULL
), tagged AS (
  SELECT ev.*,
         max(CASE WHEN k = 'm' THEN id END) OVER w AS metric_id,
         max(CASE WHEN k = 'm' THEN ts END) OVER w AS metric_ts
    FROM ev
  WINDOW w AS (ORDER BY ts, k DESC, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
), firsts AS (
  SELECT DISTINCT ON (metric_id) metric_id, ep, ws
    FROM tagged
   WHERE k = 'e' AND metric_id IS NOT NULL AND ts - metric_ts < interval '2 minutes'
   ORDER BY metric_id, ts
)
UPDATE llm_metrics l SET episode_id = f.ep, workspace_id = f.ws
  FROM firsts f WHERE l.id = f.metric_id;

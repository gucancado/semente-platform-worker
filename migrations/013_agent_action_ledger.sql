-- Ledger de dedup/auditoria do agente auditor (saturno).
-- Registra "regra R disparou pra alvo X no projeto P em T" → evita repetir
-- alerta/cobrança já feitos. É estado durável do agente (sobrevive ao redeploy
-- do container, que é stateless). Também serve de trail de auditoria do que o
-- agente fez, por projeto, com custo.
--
-- NÃO reusa `agent_project_config` (tabela de config 1-linha-por-projeto):
-- log append-heavy num blob de config daria contenção/bloat/sem query.

CREATE TABLE IF NOT EXISTS agent_action_ledger (
  id          BIGSERIAL PRIMARY KEY,
  agent       TEXT NOT NULL,
  project     TEXT NOT NULL,
  rule_key    TEXT NOT NULL,        -- qual regra disparou
  target_ref  TEXT,                 -- alvo (task id / contato / alert id) p/ dedup fino
  fired_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result      TEXT,                 -- executado | aprovacao_pendente | falha
  meta        JSONB                 -- payload livre (ação, custo, detalhes)
);

-- Lookup de dedup: "existe (agent,project,rule_key,target_ref) com fired_at > now()-janela?"
-- Comparação por range (>), não cai no bug-trap de precisão µs/ms do timestamptz.
CREATE INDEX IF NOT EXISTS idx_ledger_dedup
  ON agent_action_ledger (agent, project, rule_key, target_ref, fired_at DESC);

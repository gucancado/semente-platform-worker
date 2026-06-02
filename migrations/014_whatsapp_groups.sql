-- Catálogo de grupos WhatsApp que o agente auditor (saturno) monitora.
-- `jid` segue o MESMO formato gravado em messages/webhook_logs.identifier:
--   '+<id-do-grupo>' (sufixo @g.us removido, prefixado com '+').
-- `subject` = nome do grupo (populado via /admin/.../groups/import).
-- `project` = slug do projeto associado (nullable até atribuir na GUI).
-- Permite à GUI listar grupos com nome + projeto e fazer JOIN com messages.

CREATE TABLE IF NOT EXISTS whatsapp_groups (
  agent       TEXT NOT NULL,
  jid         TEXT NOT NULL,
  subject     TEXT,
  project     TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent, jid)
);

CREATE INDEX IF NOT EXISTS idx_wa_groups_project
  ON whatsapp_groups (agent, project);

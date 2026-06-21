-- migrations/030_whatsapp_groups_number_scope.sql
-- Permite linha de grupo escopada por NÚMERO (monitored = agent null), sem perder o
-- caminho legado (agent NOT NULL). Troca PK (agent, jid) por surrogate + índices parciais.

ALTER TABLE whatsapp_groups ADD COLUMN IF NOT EXISTS id BIGSERIAL;

-- Troca a PK composta por surrogate. PK antiga (agent, jid) impede agent NULL.
ALTER TABLE whatsapp_groups DROP CONSTRAINT IF EXISTS whatsapp_groups_pkey;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'whatsapp_groups'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE whatsapp_groups ADD PRIMARY KEY (id);
  END IF;
END $$;

ALTER TABLE whatsapp_groups ALTER COLUMN agent DROP NOT NULL;

-- Alvo dos upserts legados (agent-scoped) — preserva o import manual de grupos.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_groups_agent_jid
  ON whatsapp_groups (agent, jid) WHERE agent IS NOT NULL;

-- Alvo do sync por número (monitored).
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_groups_number_jid
  ON whatsapp_groups (whatsapp_number_id, jid) WHERE whatsapp_number_id IS NOT NULL;

-- Leitura barata do nome de DM (último push_name por thread, em listThreads).
CREATE INDEX IF NOT EXISTS idx_webhook_logs_number_identifier
  ON webhook_logs (whatsapp_number_id, identifier);

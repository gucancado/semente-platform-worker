-- migrations/057_whatsapp_group_links.sql
-- Vínculo grupo→workspace INDEPENDENTE do workspace do número.
--
-- Por que coluna NOVA e não a `workspace_id` existente: `syncGroupSubjects`
-- (src/whatsapp/group-sync.ts) faz ON CONFLICT DO UPDATE SET workspace_id =
-- EXCLUDED.workspace_id (o workspace DO NÚMERO) e `claimNumberByPhone`
-- (src/whatsapp/numbers.ts, array RESTAMP) reescreve a mesma coluna quando o
-- número muda de workspace. Gravar o vínculo ali o apagaria.
--
-- INVARIANTE: nenhum código de sync/restamp pode escrever em linked_workspace_id.

ALTER TABLE whatsapp_groups
  ADD COLUMN IF NOT EXISTS linked_workspace_id TEXT,
  ADD COLUMN IF NOT EXISTS linked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS linked_by TEXT;

CREATE INDEX IF NOT EXISTS idx_whatsapp_groups_linked_workspace
  ON whatsapp_groups (linked_workspace_id) WHERE linked_workspace_id IS NOT NULL;

-- INVARIANTE DE AUTORIZAÇÃO: um jid tem NO MÁXIMO um vínculo em todo o banco.
--
-- Sem isto o invariante seria por LINHA, não por grupo: as UNIQUE da mig 030 são
-- (agent, jid) e (whatsapp_number_id, jid) — NUNCA jid sozinho — então o mesmo
-- grupo pode ter N linhas (uma por número que o monitora, mais linhas legadas
-- agent-scoped que `src/admin/db.ts` ainda escreve com whatsapp_number_id NULL).
-- Com N linhas vinculadas, `resolveLinkedGroup` escolheria uma delas de forma
-- não-determinística e poderia devolver o número de OUTRO tenant. É a mesma
-- classe de bug que `src/whatsapp/sql-scope.ts` documenta ("identifier (JID) NÃO
-- é único entre workspaces").
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_groups_linked_jid
  ON whatsapp_groups (jid) WHERE linked_workspace_id IS NOT NULL;

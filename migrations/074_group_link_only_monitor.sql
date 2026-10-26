-- migrations/074_group_link_only_monitor.sql
-- Vínculo grupo → workspace só pode morar na linha do MONITOR DE GRUPOS
-- (`agent='saturno'`, `whatsapp_number_id IS NULL`). Linha de número lê só o
-- que AQUELE aparelho capturou: a tela do cliente perde a redundância dos dois
-- monitores (mig 072) e congela junto com o número (incidente de 2026-08-18).
-- Até aqui a regra vivia só no `pnpm whatsapp:check-group-links`, depois do
-- erro; FXN Capital foi vinculado à linha do número 18 e ficou fora do escopo
-- comum. O CHECK impõe a regra na escrita, para qualquer caminho (SQL à mão
-- incluído).
--
-- 1) Move todo vínculo de linha de número para a linha do monitor (cria a
--    linha se não existir). Dois statements, não CTE: o índice único
--    `uq_whatsapp_groups_linked_jid` é checado por linha, e o vínculo antigo
--    precisa sair antes de o novo entrar.
-- 2) Trava com CHECK.
-- Idempotente: sem vínculo em número, o bloco não faz nada.
--
-- Depois de mover, rodar `pnpm whatsapp:monitor-copy --since=<1ª msg do grupo>`
-- para trazer ao escopo do monitor o histórico que só o número tinha.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id, jid, subject, linked_workspace_id, linked_at, linked_by
      FROM whatsapp_groups
     WHERE linked_workspace_id IS NOT NULL AND whatsapp_number_id IS NOT NULL
  LOOP
    UPDATE whatsapp_groups
       SET linked_workspace_id = NULL, linked_at = NULL, linked_by = NULL
     WHERE id = r.id;

    INSERT INTO whatsapp_groups (agent, jid, subject, linked_workspace_id, linked_at, linked_by)
    VALUES ('saturno', r.jid, r.subject, r.linked_workspace_id, coalesce(r.linked_at, now()), coalesce(r.linked_by, 'mig074'))
    ON CONFLICT (agent, jid) WHERE agent IS NOT NULL
    DO UPDATE SET linked_workspace_id = EXCLUDED.linked_workspace_id,
                  linked_at = EXCLUDED.linked_at,
                  linked_by = EXCLUDED.linked_by;
  END LOOP;
END $$;

ALTER TABLE whatsapp_groups DROP CONSTRAINT IF EXISTS wg_link_only_monitor;
ALTER TABLE whatsapp_groups
  ADD CONSTRAINT wg_link_only_monitor
  CHECK (linked_workspace_id IS NULL OR whatsapp_number_id IS NULL);

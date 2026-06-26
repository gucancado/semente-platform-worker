-- migrations/037_whatsapp_disqualify_reasons_per_workspace.sql
-- Migra whatsapp_disqualify_reasons de tabela global (PK=code) para per-workspace
-- (PK composta workspace_id+code), com template de defaults e backfill duplo.
--
-- DESVIO vs. spec §4.1 PASSO 4: workspace_id é TEXT (não UUID) porque
-- whatsapp_numbers.workspace_id é TEXT em todo o codebase (ver migration 024).
-- Os valores são UUIDs do Bloquim armazenados como text; não há cast TEXT→UUID
-- no Postgres sem função explícita, então manter TEXT evita erro no backfill.
-- created_by permanece UUID conforme spec (coluna nova, sem backfill de text).

-- PASSO 0: tabela-template (idempotente)
CREATE TABLE IF NOT EXISTS whatsapp_disqualify_reason_defaults (
  code TEXT PRIMARY KEY, label TEXT NOT NULL, sort_order INT NOT NULL DEFAULT 0
);
INSERT INTO whatsapp_disqualify_reason_defaults (code, label, sort_order) VALUES
  ('interno_equipe','Equipe interna',1),
  ('profissional_busca_trabalho','Profissional buscando trabalho',2),
  ('parceria_b2b','Parceria B2B',3),
  ('fornecedor','Fornecedor',4),
  ('contabilidade_nf','Contabilidade/NF',5),
  ('spam_outro_negocio','Spam/outro negócio',6),
  ('agencia','Agência',7),
  ('sistema_whatsapp','Sistema WhatsApp',8),
  ('fora_escopo','Fora de escopo',9),
  ('fora_area_cobertura','Fora da área de cobertura',10),
  ('servico_nao_oferecido','Serviço/especialidade não oferecido',11)
ON CONFLICT (code) DO NOTHING;

-- PASSO 1: sincroniza o template com QUALQUER code global em uso hoje que não
-- esteja nos defaults (defende contra codes inseridos fora desta spec) → evita órfão.
INSERT INTO whatsapp_disqualify_reason_defaults (code, label, sort_order)
SELECT r.code, r.label, 99 FROM whatsapp_disqualify_reasons r
 WHERE r.code NOT IN (SELECT code FROM whatsapp_disqualify_reason_defaults)
ON CONFLICT (code) DO NOTHING;

-- PASSO 2: drop FK de thread_meta (integridade passa pro app, escopada por workspace)
ALTER TABLE whatsapp_thread_meta
  DROP CONSTRAINT IF EXISTS whatsapp_thread_meta_disqualify_reason_fkey;

-- PASSO 3: drop PK antiga (code)
DO $$ BEGIN
  ALTER TABLE whatsapp_disqualify_reasons DROP CONSTRAINT IF EXISTS whatsapp_disqualify_reasons_pkey;
EXCEPTION WHEN OTHERS THEN NULL; END; $$;

-- PASSO 4: colunas novas (idempotente)
-- NOTA: workspace_id é TEXT (não UUID) — alinhado com whatsapp_numbers.workspace_id TEXT.
ALTER TABLE whatsapp_disqualify_reasons
  ADD COLUMN IF NOT EXISTS workspace_id TEXT,
  ADD COLUMN IF NOT EXISTS created_by   UUID,
  ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT now();

-- PASSO 5: backfill por workspace — DUAS fontes UNIDAS (números E thread_meta),
-- cobre workspaces sem número ativo mas com reasons em uso.
-- CRÍTICO: UNION deduplica o conjunto de workspaces ANTES do CROSS JOIN. Sem isso,
-- dois INSERTs separados geram (workspace_id, code) duplicado para qualquer workspace
-- que tenha número E thread_meta, porque neste ponto NÃO existe constraint única
-- (PK antiga dropada no PASSO 3, nova só no PASSO 8) → ON CONFLICT DO NOTHING fica
-- SEM árbitro e não deduplica entre os INSERTs, quebrando o ADD PRIMARY KEY do PASSO 8.
INSERT INTO whatsapp_disqualify_reasons (workspace_id, code, label, active)
SELECT ws.workspace_id, d.code, d.label, TRUE
  FROM (
    SELECT workspace_id FROM whatsapp_numbers
    UNION
    SELECT wn.workspace_id
      FROM whatsapp_thread_meta tm
      JOIN whatsapp_numbers wn ON wn.id = tm.whatsapp_number_id
  ) ws
  CROSS JOIN whatsapp_disqualify_reason_defaults d
ON CONFLICT DO NOTHING;

-- PASSO 6: GUARD — aborta a migração se algum thread ficaria com reason órfã
DO $$ DECLARE orphan_count INT; BEGIN
  SELECT COUNT(*) INTO orphan_count
    FROM whatsapp_thread_meta tm
    JOIN whatsapp_numbers wn ON wn.id = tm.whatsapp_number_id
   WHERE tm.disqualify_reason IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM whatsapp_disqualify_reasons r
                      WHERE r.workspace_id = wn.workspace_id AND r.code = tm.disqualify_reason);
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'ABORT: % threads ficariam com disqualify_reason órfã', orphan_count;
  END IF;
END; $$;

-- PASSO 7: remove linhas globais
DELETE FROM whatsapp_disqualify_reasons WHERE workspace_id IS NULL;

-- PASSO 7.5: dedup defensivo — garante no máximo 1 linha por (workspace_id, code)
-- antes da PK composta. Idempotente e barato; defense-in-depth além do UNION do
-- PASSO 5 (protege contra qualquer estado duplicado pré-existente).
DELETE FROM whatsapp_disqualify_reasons a
 USING whatsapp_disqualify_reasons b
 WHERE a.ctid < b.ctid
   AND a.workspace_id = b.workspace_id
   AND a.code = b.code;

-- PASSO 8: NOT NULL + PK composta
ALTER TABLE whatsapp_disqualify_reasons ALTER COLUMN workspace_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE whatsapp_disqualify_reasons ADD PRIMARY KEY (workspace_id, code);
EXCEPTION WHEN invalid_table_definition THEN NULL; END; $$;

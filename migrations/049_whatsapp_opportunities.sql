-- migrations/049_whatsapp_opportunities.sql
-- CRM de Oportunidades no WhatsApp (spec:
-- beeads-central-de-dados/docs/superpowers/specs/2026-07-24-crm-oportunidades-whatsapp-design.md §3).
-- Cria a entidade Oportunidade (substitui o funil por-conversa hoje em whatsapp_thread_meta),
-- a timeline de eventos, o catálogo de etiquetas por workspace e a junção oportunidade↔etiqueta.

-- ── Bloco 1: tabela de oportunidades ──────────────────────────────────────────
-- whatsapp_number_id é BIGINT (consistente com whatsapp_numbers.id, migration 033).
-- (whatsapp_number_id, identifier) identifica a conversa; SEM FK possível — thread é
-- derivada de messages/whatsapp_thread_meta, não uma tabela própria.
-- workspace_id é SEMPRE derivado do número no server (nunca do caller) — TEXT sem FK,
-- mesmo padrão de workspace_id em whatsapp_provision_links/workspace_title_rules.
CREATE TABLE IF NOT EXISTS whatsapp_opportunities (
  id                 BIGSERIAL PRIMARY KEY,
  whatsapp_number_id BIGINT      NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  identifier         TEXT        NOT NULL,
  workspace_id       TEXT        NOT NULL,
  title              TEXT,
  status             TEXT        NOT NULL DEFAULT 'em_andamento'
                        CHECK (status IN ('em_andamento','ganho','perdido')),
  qualification      TEXT        NOT NULL DEFAULT 'indefinido'
                        CHECK (qualification IN ('indefinido','qualificado','desqualificado')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         TEXT,                     -- acting user (uuid Bloquim) | 'migration'
  closed_at          TIMESTAMPTZ               -- regras completas na spec §3.2
);

-- Constraint nomeada composta (não pode usar IF NOT EXISTS em ADD CONSTRAINT) — guarda
-- via pg_constraint, mesmo padrão de thread_meta_stage_coherente na migration 033.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'opp_ganho_qualificado'
      AND conrelid = 'whatsapp_opportunities'::regclass
  ) THEN
    ALTER TABLE whatsapp_opportunities
      ADD CONSTRAINT opp_ganho_qualificado
        CHECK (status <> 'ganho' OR qualification = 'qualificado');
  END IF;
END;
$$;

-- Índices de acesso: por conversa, por status (funil) e por data de criação (série).
CREATE INDEX IF NOT EXISTS idx_whatsapp_opportunities_number_identifier
  ON whatsapp_opportunities (whatsapp_number_id, identifier);
CREATE INDEX IF NOT EXISTS idx_whatsapp_opportunities_ws_status
  ON whatsapp_opportunities (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_opportunities_ws_created
  ON whatsapp_opportunities (workspace_id, created_at);

-- ── Bloco 2: timeline de eventos da oportunidade (molde: whatsapp_thread_meta_log) ──
CREATE TABLE IF NOT EXISTS whatsapp_opportunity_events (
  id             BIGSERIAL PRIMARY KEY,
  opportunity_id BIGINT      NOT NULL REFERENCES whatsapp_opportunities(id) ON DELETE CASCADE,
  field          TEXT        NOT NULL
                    CHECK (field IN ('created','status','qualification','title','tag_added','tag_removed')),
  old_value      TEXT,
  new_value      TEXT,
  changed_by     TEXT,
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_opportunity_events_opp_at
  ON whatsapp_opportunity_events (opportunity_id, changed_at);

-- ── Bloco 3: catálogo de etiquetas por workspace ──────────────────────────────
-- Nome preserva casing na exibição; unicidade é case-insensitive (índice em lower(name)).
-- color é slug de paleta fixa (~10 cores do DS); validação da lista fica na app layer (Task 4).
CREATE TABLE IF NOT EXISTS whatsapp_tags (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id TEXT   NOT NULL,
  name         TEXT   NOT NULL,
  color        TEXT   NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_tags_ws_name
  ON whatsapp_tags (workspace_id, lower(name));

-- ── Bloco 4: junção oportunidade ↔ etiqueta ───────────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_opportunity_tags (
  opportunity_id BIGINT NOT NULL REFERENCES whatsapp_opportunities(id) ON DELETE CASCADE,
  tag_id         BIGINT NOT NULL REFERENCES whatsapp_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (opportunity_id, tag_id)
);

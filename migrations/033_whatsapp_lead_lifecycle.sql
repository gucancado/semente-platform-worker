-- migrations/033_whatsapp_lead_lifecycle.sql
-- Fase 2 — ciclo de vida de lead: razões de desqualificação (ref), colunas de
-- qualificação em whatsapp_thread_meta, constraint de coerência e tabela de tags.
-- is_lead (triagem booleana) permanece; o funil de qualificação é ortogonal.

-- ── Bloco 1: tabela de referência de razões de desqualificação ───────────────
-- Criada ANTES das colunas abaixo porque disqualify_reason referencia esta tabela.
CREATE TABLE IF NOT EXISTS whatsapp_disqualify_reasons (
  code   TEXT    PRIMARY KEY,
  label  TEXT    NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Semente das categorias iniciais; ON CONFLICT DO NOTHING torna re-execução segura.
INSERT INTO whatsapp_disqualify_reasons (code, label) VALUES
  ('interno_equipe',              'Equipe interna'),
  ('profissional_busca_trabalho', 'Profissional buscando trabalho'),
  ('parceria_b2b',                'Parceria B2B'),
  ('fornecedor',                  'Fornecedor'),
  ('contabilidade_nf',            'Contabilidade/NF'),
  ('spam_outro_negocio',          'Spam/outro negócio'),
  ('agencia',                     'Agência'),
  ('sistema_whatsapp',            'Sistema WhatsApp'),
  ('fora_escopo',                 'Fora de escopo')
ON CONFLICT (code) DO NOTHING;

-- ── Bloco 2: colunas de qualificação em whatsapp_thread_meta ─────────────────
-- Todas nullable: linhas existentes recebem NULL (nenhuma migração de dados necessária).
ALTER TABLE whatsapp_thread_meta
  ADD COLUMN IF NOT EXISTS lead_stage        TEXT,                                              -- funil: 'qualificado'|'desqualificado'|'cliente'|'perdido'|NULL
  ADD COLUMN IF NOT EXISTS lead_temperature  TEXT,                                              -- 'quente'|'morno'|'frio'
  ADD COLUMN IF NOT EXISTS lead_source       TEXT,                                              -- 'site'|'indicacao'|'ads'|'organico'|'desconhecido'
  ADD COLUMN IF NOT EXISTS disqualify_reason TEXT REFERENCES whatsapp_disqualify_reasons(code), -- FK válida: tabela de referência já existe acima
  ADD COLUMN IF NOT EXISTS notes             TEXT;

-- ── Bloco 3: constraint de coerência entre lead_stage e is_lead ──────────────
-- Semântica: se lead_stage = 'desqualificado' então is_lead DEVE ser FALSE.
-- Guarda com DO $$ para que re-execução (ou estado parcial prévio) não gere erro.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'thread_meta_stage_coherente'
      AND conrelid = 'whatsapp_thread_meta'::regclass
  ) THEN
    ALTER TABLE whatsapp_thread_meta
      ADD CONSTRAINT thread_meta_stage_coherente
        CHECK (lead_stage IS DISTINCT FROM 'desqualificado' OR is_lead = FALSE);
  END IF;
END;
$$;

-- ── Bloco 4: tabela de tags por thread + índice de busca ─────────────────────
-- PK composta garante unicidade de (número, conversa, tag); ON DELETE CASCADE
-- propaga deleção do número automaticamente.
-- whatsapp_number_id é BIGINT (consistente com whatsapp_numbers.id e whatsapp_thread_meta).
CREATE TABLE IF NOT EXISTS whatsapp_thread_tags (
  whatsapp_number_id BIGINT NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  identifier         TEXT   NOT NULL,
  tag                TEXT   NOT NULL,
  PRIMARY KEY (whatsapp_number_id, identifier, tag)
);

-- Índice para filtrar/agregar tags por número (ex.: stats byTag).
CREATE INDEX IF NOT EXISTS idx_whatsapp_thread_tags_number_tag
  ON whatsapp_thread_tags (whatsapp_number_id, tag);

-- migrations/051_crm_v3_expand.sql
-- CRM WhatsApp v3 — Fase A: fundação (expand; contract vem na Fase D, spec
-- beeads-central-de-dados/docs/superpowers/specs/2026-07-29-crm-whatsapp-v3-kanban-ia-design.md §3.1-3.2, §12.1).
-- Adiciona is_qualified/loss_reason em whatsapp_opportunities (+ CHECKs + índices novos),
-- description/created_by/updated_by em whatsapp_tags, 'loss_reason' no CHECK de field dos
-- eventos, e as tabelas de catálogo whatsapp_loss_reasons + whatsapp_workspace_settings.
-- NADA é dropado aqui — qualification e o CHECK opp_ganho_qualificado (049) ficam
-- (worker v3 escreve as duas colunas durante a janela de deploy; contract fica pra Fase D).

-- lock_timeout curto: se a tabela estiver sob lock no boot (ex.: coleta em curso),
-- falha rápido em vez de segurar a janela de deploy — o runner re-tenta no próximo
-- deploy (o runner envolve cada migration em BEGIN/COMMIT; SET LOCAL vale só p/ esta tx).
SET LOCAL lock_timeout = '10s';

-- ── Bloco 1: whatsapp_opportunities — colunas novas ───────────────────────────
ALTER TABLE whatsapp_opportunities ADD COLUMN IF NOT EXISTS is_qualified BOOLEAN; -- NULL=indefinido TRUE=qualificado FALSE=desqualificado
ALTER TABLE whatsapp_opportunities ADD COLUMN IF NOT EXISTS loss_reason TEXT;     -- código (sistema ou catálogo); só existe em perda

-- fix de rows sujas ANTES do backfill/CHECKs (spec §12.1 item 1): desqualificada
-- ainda em_andamento não é um estado válido sob os CHECKs novos abaixo — fecha como perdido.
UPDATE whatsapp_opportunities
   SET status = 'perdido', closed_at = updated_at
 WHERE qualification = 'desqualificado' AND status = 'em_andamento';

-- backfill is_qualified <- qualification (indefinido→NULL, qualificado→TRUE, desqualificado→FALSE)
UPDATE whatsapp_opportunities
   SET is_qualified = CASE qualification
         WHEN 'qualificado' THEN TRUE
         WHEN 'desqualificado' THEN FALSE
         ELSE NULL
       END
 WHERE is_qualified IS NULL AND qualification IS NOT NULL;

-- ── Trigger temporário da janela expand — DROPAR no contract (Fase D) junto com a coluna ──
-- Durante o rolling deploy o worker ANTIGO ainda escreve SÓ `qualification` (não
-- conhece is_qualified). Sem sincronizar, um PATCH antigo (ex.: status='ganho' +
-- qualification='qualificado' deixando is_qualified NULL) tornaria as duas colunas
-- incoerentes: a projeção v3 (board, que lê is_qualified) veria estado errado e um
-- 'ganho' com is_qualified NULL viola a invariante da app (→ 500). Este trigger
-- mantém as duas colunas coerentes nos DOIS sentidos, cobrindo o worker antigo
-- (qualification→is_qualified) e o novo (is_qualified→qualification, no-op pois já
-- escreve as duas). Criado DEPOIS do backfill acima de propósito, pra não disparar
-- em massa nas rows históricas (o backfill já as deixou coerentes) — spec §4.11/§12.1.
CREATE OR REPLACE FUNCTION crm_v3_sync_qualification() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_qualified IS NOT NULL THEN
      -- INSERT trazendo is_qualified (worker novo) → deriva qualification.
      NEW.qualification := CASE WHEN NEW.is_qualified THEN 'qualificado' ELSE 'desqualificado' END;
    ELSIF NEW.qualification IS NOT NULL AND NEW.qualification <> 'indefinido' THEN
      -- INSERT só com qualification (worker antigo, is_qualified NULL) → deriva is_qualified.
      NEW.is_qualified := CASE NEW.qualification
        WHEN 'qualificado' THEN TRUE WHEN 'desqualificado' THEN FALSE ELSE NULL END;
      -- worker v2 na janela: desqualificar via coluna legada (is_qualified→FALSE)
      -- fecha a opp como perdida (espelha §4.3 do kernel + o fix-dirty da 051),
      -- senão o CHECK opp_v3_desqualificado_perdido dispara 23514. Só neste ramo
      -- DERIVADO (worker antigo); o ramo com is_qualified explícito é o kernel v3.
      IF NEW.is_qualified = FALSE AND NEW.status <> 'perdido' THEN
        NEW.status := 'perdido';
        NEW.closed_at := COALESCE(NEW.closed_at, NOW());
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: a coluna que MUDOU dita a derivação da outra; is_qualified (fonte v3)
  -- tem precedência quando ambas mudam no mesmo statement.
  IF NEW.is_qualified IS DISTINCT FROM OLD.is_qualified THEN
    NEW.qualification := CASE
      WHEN NEW.is_qualified IS NULL THEN 'indefinido'
      WHEN NEW.is_qualified THEN 'qualificado' ELSE 'desqualificado' END;
  ELSIF NEW.qualification IS DISTINCT FROM OLD.qualification THEN
    NEW.is_qualified := CASE NEW.qualification
      WHEN 'qualificado' THEN TRUE WHEN 'desqualificado' THEN FALSE ELSE NULL END;
    -- worker v2 na janela: desqualificar opp ABERTA via coluna legada
    -- (is_qualified→FALSE) fecha como perdida (§4.3 do kernel + fix-dirty da 051),
    -- senão o CHECK opp_v3_desqualificado_perdido dispara 23514. Só neste ramo
    -- DERIVADO; quando is_qualified vem explícito (acima) é o kernel v3, intocado.
    IF NEW.is_qualified = FALSE AND NEW.status <> 'perdido' THEN
      NEW.status := 'perdido';
      NEW.closed_at := COALESCE(NEW.closed_at, NOW());
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS crm_v3_sync_qualification_trg ON whatsapp_opportunities;
CREATE TRIGGER crm_v3_sync_qualification_trg
  BEFORE INSERT OR UPDATE ON whatsapp_opportunities
  FOR EACH ROW EXECUTE FUNCTION crm_v3_sync_qualification();

-- Constraints nomeadas (ADD CONSTRAINT não aceita IF NOT EXISTS) — guarda via
-- pg_constraint, mesmo padrão de opp_ganho_qualificado na migration 049.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'opp_v3_ganho_qualificado'
      AND conrelid = 'whatsapp_opportunities'::regclass
  ) THEN
    ALTER TABLE whatsapp_opportunities
      ADD CONSTRAINT opp_v3_ganho_qualificado
        CHECK (status <> 'ganho' OR is_qualified = TRUE);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'opp_v3_desqualificado_perdido'
      AND conrelid = 'whatsapp_opportunities'::regclass
  ) THEN
    ALTER TABLE whatsapp_opportunities
      ADD CONSTRAINT opp_v3_desqualificado_perdido
        CHECK (is_qualified IS DISTINCT FROM FALSE OR status = 'perdido');
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'opp_v3_loss_reason_so_em_perda'
      AND conrelid = 'whatsapp_opportunities'::regclass
  ) THEN
    ALTER TABLE whatsapp_opportunities
      ADD CONSTRAINT opp_v3_loss_reason_so_em_perda
        CHECK (status = 'perdido' OR loss_reason IS NULL);
  END IF;
END;
$$;

-- Índices novos: par aberto (poller/pipeline de criação) e (número, status) pro board.
CREATE INDEX IF NOT EXISTS idx_opp_open_pair ON whatsapp_opportunities
  (whatsapp_number_id, identifier) WHERE status = 'em_andamento';
CREATE INDEX IF NOT EXISTS idx_opp_number_status ON whatsapp_opportunities
  (whatsapp_number_id, status);

-- ── Bloco 2: whatsapp_tags — metadados de autoria ─────────────────────────────
ALTER TABLE whatsapp_tags ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE whatsapp_tags ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE whatsapp_tags ADD COLUMN IF NOT EXISTS updated_by TEXT;

-- ── Bloco 3: whatsapp_opportunity_events — field ganha 'loss_reason' ──────────
-- O CHECK de field (049, linhas 57-58) foi declarado INLINE na definição da coluna,
-- sem constraint nomeada explícita — Postgres gerou o nome default <tabela>_<coluna>_check
-- (conferido em migrations/049_whatsapp_opportunities.sql: nenhum "CONSTRAINT <nome>" ali).
ALTER TABLE whatsapp_opportunity_events
  DROP CONSTRAINT IF EXISTS whatsapp_opportunity_events_field_check;
ALTER TABLE whatsapp_opportunity_events
  ADD CONSTRAINT whatsapp_opportunity_events_field_check
    CHECK (field IN ('created','status','qualification','title','tag_added','tag_removed','loss_reason'));

-- ── Bloco 4: whatsapp_loss_reasons — catálogo custom por workspace ────────────
-- Códigos de SISTEMA ('nao_lead', 'lead_nao_respondeu', 'atendente_nao_respondeu') são
-- constantes hardcoded na app, SEM row aqui (spec §3.2).
CREATE TABLE IF NOT EXISTS whatsapp_loss_reasons (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id TEXT        NOT NULL,
  code         TEXT        NOT NULL,
  label        TEXT        NOT NULL,
  description  TEXT,
  active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by   TEXT,
  updated_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_loss_reasons_ws_code
  ON whatsapp_loss_reasons (workspace_id, lower(code));

-- ── Bloco 5: whatsapp_workspace_settings — 1 row por workspace ────────────────
-- Seed pros workspaces existentes + criação no provisionamento de número novo ficam
-- fora desta migration (script one-off, spec §12.1 item 4).
CREATE TABLE IF NOT EXISTS whatsapp_workspace_settings (
  workspace_id          TEXT PRIMARY KEY,
  auto_loss_days        INT         DEFAULT 7,
  new_opp_after_days    INT         NOT NULL DEFAULT 30,
  ai_engine_enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
  ai_lead_guidance      TEXT,
  ai_qualified_guidance TEXT,
  pipeline_since        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by            TEXT
);

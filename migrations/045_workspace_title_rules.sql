-- 045: atribuição de reunião por PADRÃO NO TÍTULO (fallback quando o domínio
-- dos participantes não resolve — muitas reuniões só têm beeads + freemail,
-- mas o título nomeia o cliente: "Hoenka + BeeAds", "Luhma + BeeAds").
-- `pattern` é casado como SUBSTRING case-insensitive contra o título.
CREATE TABLE IF NOT EXISTS workspace_title_rules (
  id BIGSERIAL PRIMARY KEY,
  pattern TEXT NOT NULL UNIQUE,        -- lowercase; casado por substring no título lowercased
  workspace_id TEXT NOT NULL,
  project_slug TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- attribution_method ganha 'title' (o CHECK da migration 015 não o inclui).
ALTER TABLE episodes DROP CONSTRAINT IF EXISTS episodes_attr_method_chk;
ALTER TABLE episodes ADD CONSTRAINT episodes_attr_method_chk
  CHECK (attribution_method IN ('domain','calendar','manual','internal','group_tag','contact_route','title','none'));

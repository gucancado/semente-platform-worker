-- Espelho do vocabulário de tags do painel em whatsapp_tags. Tombstone em vez de
-- DELETE: o CASCADE de whatsapp_opportunity_tags apagaria os vínculos.
ALTER TABLE whatsapp_tags ADD COLUMN IF NOT EXISTS external_id uuid;
ALTER TABLE whatsapp_tags ADD COLUMN IF NOT EXISTS parent_external_id uuid;
ALTER TABLE whatsapp_tags ADD COLUMN IF NOT EXISTS ancestor_external_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE whatsapp_tags ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE whatsapp_tags ADD COLUMN IF NOT EXISTS synced_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_tags_external_id
  ON whatsapp_tags (external_id) WHERE external_id IS NOT NULL;

-- Nome só é único entre as vivas: a tag tombada libera o nome para ser recriado.
DROP INDEX IF EXISTS uq_whatsapp_tags_ws_name;
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_tags_ws_name
  ON whatsapp_tags (workspace_id, lower(name)) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_opportunity_tags_tag
  ON whatsapp_opportunity_tags (tag_id);

-- Sugestão de tag nova (nível 2) convive com a de guidance.
ALTER TABLE whatsapp_ai_suggestions DROP CONSTRAINT IF EXISTS whatsapp_ai_suggestions_kind_check;
ALTER TABLE whatsapp_ai_suggestions ADD CONSTRAINT whatsapp_ai_suggestions_kind_check
  CHECK (kind IN ('guidance_lead','guidance_qualified','tag_new'));

DROP INDEX IF EXISTS uq_ai_suggestions_pending;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_suggestions_pending
  ON whatsapp_ai_suggestions (workspace_id, kind) WHERE status = 'pending' AND kind <> 'tag_new';

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_suggestions_pending_tag_new
  ON whatsapp_ai_suggestions (workspace_id, lower(payload->>'name'))
  WHERE status = 'pending' AND kind = 'tag_new';

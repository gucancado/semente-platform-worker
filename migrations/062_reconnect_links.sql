-- Link de reconexão: aponta para uma instância Evolution QUE JÁ EXISTE.
-- target_instance NULL = link de conexão nova (comportamento original).
ALTER TABLE whatsapp_provision_links ADD COLUMN IF NOT EXISTS target_instance TEXT;
ALTER TABLE whatsapp_provision_links ADD COLUMN IF NOT EXISTS target_label    TEXT;
-- Trava de identidade: telefone (formato +E164, o mesmo de whatsapp_numbers.phone)
-- que o pareamento DEVE apresentar. Obrigatório em todo link de reconexão.
ALTER TABLE whatsapp_provision_links ADD COLUMN IF NOT EXISTS expected_phone  TEXT;

-- Instância de sistema (ex.: saturno) não pertence a workspace nenhum.
ALTER TABLE whatsapp_provision_links ALTER COLUMN workspace_id DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE whatsapp_provision_links
    ADD CONSTRAINT wpl_target_chk CHECK (target_instance IS NOT NULL OR workspace_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Link de reconexão SEM trava de telefone não pode existir.
DO $$ BEGIN
  ALTER TABLE whatsapp_provision_links
    ADD CONSTRAINT wpl_expected_phone_chk CHECK (target_instance IS NULL OR expected_phone IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Estado novo 'blocked': pareamento com telefone divergente. O CHECK original
-- é inline na 046 (nome auto-gerado) — recriado com a lista completa.
ALTER TABLE whatsapp_provision_links DROP CONSTRAINT IF EXISTS whatsapp_provision_links_status_check;
ALTER TABLE whatsapp_provision_links
  ADD CONSTRAINT whatsapp_provision_links_status_check
  CHECK (status IN ('active','consumed','exhausted','expired','blocked'));

CREATE INDEX IF NOT EXISTS idx_wa_provision_links_target
  ON whatsapp_provision_links (target_instance) WHERE target_instance IS NOT NULL;

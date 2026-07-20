-- Link de uso único para conectar um número de WhatsApp por usuário deslogado.
CREATE TABLE IF NOT EXISTS whatsapp_provision_links (
  token               TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  created_by          TEXT,
  max_clicks          INT NOT NULL DEFAULT 10,
  clicks_used         INT NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','consumed','exhausted','expired')),
  consumed_at         TIMESTAMPTZ,
  connected_number_id BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_provision_links_workspace ON whatsapp_provision_links (workspace_id);
CREATE INDEX IF NOT EXISTS idx_wa_provision_links_expires   ON whatsapp_provision_links (expires_at);

-- Liga a tentativa de provisionamento (staging) ao link que a originou,
-- para o webhook de conexão consumir o link certo.
ALTER TABLE whatsapp_provisioning ADD COLUMN IF NOT EXISTS provision_link_token TEXT;

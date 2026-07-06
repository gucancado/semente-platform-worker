-- migrations/042_whatsapp_global_phone.sql
-- Número vira identidade GLOBAL: 1 ficha por telefone no sistema (workspace_id mutável).
-- Substitui o unique por-workspace (mig 039) pelo unique global.
DROP INDEX IF EXISTS uq_whatsapp_numbers_ws_phone;
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_numbers_phone
  ON whatsapp_numbers (phone) WHERE phone IS NOT NULL;

-- Sinal de bloqueio do onboarding: telefone já ativo em outro workspace.
ALTER TABLE whatsapp_provisioning ADD COLUMN IF NOT EXISTS blocked_workspace_id TEXT;

-- migrations/038_whatsapp_provisioning.sql
-- Staging transitório do onboarding QR-first. Uma linha por instância Evolution
-- AGUARDANDO pareamento. Some quando: conecta (commit p/ whatsapp_numbers), aborta,
-- ou o reaper varre por expires_at. whatsapp_numbers só recebe número que conectou.
CREATE TABLE IF NOT EXISTS whatsapp_provisioning (
  evolution_instance TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL,
  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_provisioning_expires
  ON whatsapp_provisioning (expires_at);

-- migrations/028_whatsapp_groups_number.sql
ALTER TABLE whatsapp_groups
  ADD COLUMN IF NOT EXISTS whatsapp_number_id BIGINT REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS workspace_id TEXT;
CREATE INDEX IF NOT EXISTS idx_whatsapp_groups_number ON whatsapp_groups (whatsapp_number_id);

-- migrations/039_whatsapp_removed_at.sql
-- Lifecycle ortogonal ao estado de conexão: removed_at distingue "removido de
-- propósito" (escondido) de "offline/caiu" (reconectável). status segue só sobre conexão.
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

-- Backfill: hoje todos os 'disconnected' são removidos de propósito (Art Blue, Hoenka).
UPDATE whatsapp_numbers SET removed_at = updated_at
 WHERE status = 'disconnected' AND removed_at IS NULL;

-- ≤1 ficha ATIVA por (workspace, telefone): sustenta a revival e serve de índice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_numbers_ws_phone
  ON whatsapp_numbers (workspace_id, phone)
  WHERE phone IS NOT NULL AND removed_at IS NULL;

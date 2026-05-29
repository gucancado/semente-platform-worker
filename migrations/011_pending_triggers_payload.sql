-- Entrega 5: triggers tipados (inbox default | meeting_reconcile).
-- Adiciona suporte a trigger_type + payload em pending_triggers.

ALTER TABLE pending_triggers
  ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'inbox',
  ADD COLUMN payload JSONB,
  ALTER COLUMN last_inbox_id DROP NOT NULL;

-- Substitui UNIQUE INDEX pra que meeting_reconcile não colida com debounce de inbox.
-- O original (008_pending_triggers.sql) era:
--   CREATE UNIQUE INDEX uq_pending_triggers_pending_per_conv
--     ON pending_triggers (agent, identifier) WHERE status = 'pending';
DROP INDEX IF EXISTS uq_pending_triggers_pending_per_conv;
CREATE UNIQUE INDEX uq_pending_triggers_pending_inbox
  ON pending_triggers (agent, identifier)
  WHERE status = 'pending' AND trigger_type = 'inbox';

-- Lookup pra triggers por tipo.
CREATE INDEX idx_pending_triggers_type ON pending_triggers(trigger_type);

COMMENT ON COLUMN pending_triggers.trigger_type IS
  'inbox (default, mensagem nova) | meeting_reconcile (mudanca em reuniao detectada).';
COMMENT ON COLUMN pending_triggers.payload IS
  'JSONB. inbox: NULL. meeting_reconcile: { event, meeting_id, old_slot_iso?, new_slot_iso? }.';

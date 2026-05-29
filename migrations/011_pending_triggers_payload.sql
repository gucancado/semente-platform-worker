-- Entrega 5: suporte a triggers tipados com payload arbitrário.
-- 'inbox' (default, mensagem nova) ou 'meeting_reconcile' (notificação de mudança).

ALTER TABLE pending_triggers
  ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'inbox',
  ADD COLUMN payload JSONB;

CREATE INDEX idx_pending_triggers_type ON pending_triggers(trigger_type);

COMMENT ON COLUMN pending_triggers.trigger_type IS
  'Tipo do trigger: "inbox" (default, mensagem nova) ou "meeting_reconcile" (notificacao de mudanca em reuniao).';
COMMENT ON COLUMN pending_triggers.payload IS
  'Dados estruturados pro agente. Schema depende do trigger_type. Para meeting_reconcile: { event, meeting_id, old_slot_iso?, new_slot_iso? }.';

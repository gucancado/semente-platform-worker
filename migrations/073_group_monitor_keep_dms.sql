-- migrations/073_group_monitor_keep_dms.sql
-- Monitor que TAMBÉM é número de atendimento (ex.: número da BeeAds no slot A):
-- keep_dms=true mantém as DMs no fluxo normal do número (CRM, IA, mídia) e o
-- slot só acrescenta a cópia dos grupos para o escopo do monitor.
-- Default false = comportamento da mig 072 (número-monitor é SÓ grupos).
ALTER TABLE group_monitors ADD COLUMN IF NOT EXISTS keep_dms boolean NOT NULL DEFAULT false;

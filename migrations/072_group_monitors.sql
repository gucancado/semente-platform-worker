-- migrations/072_group_monitors.sql
-- Slots "Monitor de grupos A" e "B": as instâncias Evolution que alimentam o
-- escopo do monitor (messages.agent='saturno'). Trocáveis a qualquer momento
-- (pnpm whatsapp:group-monitor set). Instância = 'saturno' (caminho legado) ou
-- uma instância de whatsapp_numbers.
CREATE TABLE IF NOT EXISTS group_monitors (
  slot text PRIMARY KEY CHECK (slot IN ('A','B')),
  instance text NOT NULL UNIQUE,
  phone text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
INSERT INTO group_monitors (slot, instance, phone, updated_by) VALUES
  ('A', 'saturno', '+553195950748', 'mig072'),
  ('B', 'ws-a6908c04-24bd8aa8', '+553196039118', 'mig072')
ON CONFLICT (slot) DO NOTHING;

-- Número-monitor que já estava fora ANTES da mig 066 (ex.: ws-a6908c04-24bd8aa8,
-- 'connecting' desde 2026-08-18) não tem episódio em instance_outages; sem ele a
-- interseção A∩B tratava o slot como "no ar". Abre o episódio aproximado
-- (fonte 'detected_now'); o fechamento é por instance em updateNumberStatus
-- (connected). Idempotente: NOT EXISTS + índice parcial uq_instance_outages_open.
INSERT INTO instance_outages (instance, kind, number_id, started_at, started_at_source, reason, detected_by)
SELECT wn.evolution_instance, 'number', wn.id, COALESCE(wn.disconnected_since, now()),
       'detected_now', 'mig072_backfill', 'mig072'
  FROM group_monitors gm
  JOIN whatsapp_numbers wn ON wn.evolution_instance = gm.instance AND wn.removed_at IS NULL
 WHERE wn.status <> 'connected'
   AND NOT EXISTS (SELECT 1 FROM instance_outages o WHERE o.instance = gm.instance AND o.ended_at IS NULL)
ON CONFLICT (instance) WHERE ended_at IS NULL DO NOTHING;

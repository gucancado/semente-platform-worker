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

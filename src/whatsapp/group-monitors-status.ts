// src/whatsapp/group-monitors-status.ts
// Status dos slots "Monitor de grupos A/B" pro painel. Lê os slots FRESCOS (sem o
// cache de 30s do caminho quente do webhook).
import type { Pool } from 'pg';
import { MONITOR_AGENT, monitorLabel, type MonitorSlot } from './group-monitors.js';

export type MonitorStatus = {
  slot: MonitorSlot; label: string; phone: string; instance: string;
  status: 'connected' | 'disconnected' | 'unknown';
  since: string | null; lastMessageAt: string | null;
};

export function deriveMonitorStatus(p: {
  openOutageStartedAt: string | null; numberStatus: string | null;
  numberDisconnectedSince: string | null; isNumber: boolean;
}): { status: 'connected' | 'disconnected'; since: string | null } {
  if (p.openOutageStartedAt) return { status: 'disconnected', since: p.openOutageStartedAt };
  if (p.isNumber && p.numberStatus !== 'connected') return { status: 'disconnected', since: p.numberDisconnectedSince };
  return { status: 'connected', since: null };
}

const iso = (v: unknown): string | null => (v ? new Date(v as any).toISOString() : null);

// Uma query por monitor. Último registro de MENSAGEM DE GRUPO (identifier em
// whatsapp_groups). Número: escopo por whatsapp_number_id; instância de sistema:
// agent do monitor, sem número, só captura live (não cópias).
const STATUS_SQL = `
SELECT
  (SELECT started_at FROM instance_outages WHERE instance = $1 AND ended_at IS NULL LIMIT 1) AS open_started,
  wn.id AS number_id, wn.status AS number_status, wn.disconnected_since,
  CASE WHEN wn.id IS NULL THEN
    (SELECT m.created_at FROM messages m
      WHERE m.agent = $2 AND m.whatsapp_number_id IS NULL AND m.ingest_source = 'live'
        AND m.identifier IN (SELECT jid FROM whatsapp_groups)
      ORDER BY m.created_at DESC LIMIT 1)
  ELSE
    (SELECT m.created_at FROM messages m
      WHERE m.whatsapp_number_id = wn.id
        AND m.identifier IN (SELECT jid FROM whatsapp_groups)
      ORDER BY m.created_at DESC LIMIT 1)
  END AS last_msg
FROM (SELECT 1) x
LEFT JOIN whatsapp_numbers wn ON wn.evolution_instance = $1 AND wn.removed_at IS NULL`;

export async function listMonitorStatus(pool: Pool): Promise<MonitorStatus[]> {
  const { rows: slots } = await pool.query(`SELECT slot, instance, phone FROM group_monitors ORDER BY slot`);
  const out: MonitorStatus[] = [];
  for (const s of slots) {
    const { rows } = await pool.query(STATUS_SQL, [s.instance, MONITOR_AGENT]);
    const r = rows[0] ?? {};
    const d = deriveMonitorStatus({
      openOutageStartedAt: iso(r.open_started),
      numberStatus: r.number_status ?? null,
      numberDisconnectedSince: iso(r.disconnected_since),
      isNumber: r.number_id != null,
    });
    out.push({
      slot: s.slot as MonitorSlot, label: monitorLabel(s.slot as MonitorSlot),
      phone: String(s.phone), instance: String(s.instance),
      status: d.status, since: d.since, lastMessageAt: iso(r.last_msg),
    });
  }
  return out;
}

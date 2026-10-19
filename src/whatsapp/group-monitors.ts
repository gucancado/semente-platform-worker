// src/whatsapp/group-monitors.ts
// Slots "Monitor de grupos A/B" (mig 072). Toda instância de slot alimenta o
// escopo do monitor (messages.agent = MONITOR_AGENT).
import type { Pool } from 'pg';

/** Chave interna do escopo do monitor. Não renomear: os grupos e o histórico vivem nela. */
export const MONITOR_AGENT = 'saturno';
export type MonitorSlot = 'A' | 'B';
/** keepDms (mig 073): o monitor também é número de atendimento — DM segue o fluxo normal. */
export type GroupMonitor = { slot: MonitorSlot; instance: string; phone: string; keepDms?: boolean };

const TTL_MS = 30_000;
let cache: { at: number; value: GroupMonitor[] } | null = null;
let lastGood: GroupMonitor[] | null = null;

export function monitorLabel(slot: MonitorSlot): string {
  return `Monitor de grupos ${slot}`;
}

export function invalidateMonitors(): void {
  cache = null;
  lastGood = null;
}

/** Caminho quente do webhook: cache 30s. Falha de leitura NUNCA lança: devolve o
 *  último valor bom ou [] (o ingest segue como antes da feature). */
export async function loadMonitors(pool: Pool, now: () => number = Date.now): Promise<GroupMonitor[]> {
  const t = now();
  if (cache && t - cache.at < TTL_MS) return cache.value;
  try {
    const { rows } = await pool.query(`SELECT slot, instance, phone, keep_dms FROM group_monitors ORDER BY slot`);
    const value = rows.map((r: any) => ({ slot: r.slot as MonitorSlot, instance: String(r.instance), phone: String(r.phone), keepDms: r.keep_dms === true }));
    cache = { at: t, value };
    lastGood = value;
    return value;
  } catch {
    const value = lastGood ?? [];
    cache = { at: t, value };
    return value;
  }
}

export function monitorForInstance(monitors: GroupMonitor[], instance: string): GroupMonitor | null {
  return monitors.find((m) => m.instance === instance) ?? null;
}

export type MonitorIngestPlan = 'drop_dm' | 'copy' | 'none';

export function planMonitorIngest(p: { isMonitor: boolean; isGroup: boolean; hasMonitorRow: boolean; hasText: boolean; keepDms?: boolean }): MonitorIngestPlan {
  if (!p.isMonitor) return 'none';
  if (!p.isGroup) return p.keepDms ? 'none' : 'drop_dm';
  return p.hasMonitorRow && p.hasText ? 'copy' : 'none';
}

export type MonitorCopyRow = {
  agent: string; channel: string; identifier: string; author: string | null; text: string; evolution_event_id: string;
};

export function buildMonitorCopy(p: { channel: string; identifier: string; author: string | null; text: string; eventId: string; monitorPhone: string }): MonitorCopyRow {
  return {
    agent: MONITOR_AGENT,
    channel: p.channel,
    identifier: p.identifier,
    // Mensagem enviada pelo próprio aparelho (fromMe) costuma vir sem author.
    author: p.author ?? p.monitorPhone,
    text: p.text,
    evolution_event_id: p.eventId,
  };
}

export async function hasMonitorGroupRow(pool: Pool, jid: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM whatsapp_groups WHERE agent = $1 AND jid = $2 LIMIT 1`, [MONITOR_AGENT, jid]);
  return rows.length > 0;
}

/** Dedup pelo índice uq_messages_inbound_event (agent, evolution_event_id): quem
 *  chegar primeiro fica; os demais caem no DO NOTHING. */
export async function insertMonitorCopy(pool: Pool, row: MonitorCopyRow): Promise<{ inserted: boolean }> {
  const { rows } = await pool.query(
    `INSERT INTO messages (agent, project, channel, identifier, author, direction, text, evolution_event_id,
                           whatsapp_number_id, workspace_id, ingest_source)
     VALUES ($1, NULL, $2, $3, $4, 'inbound', $5, $6, NULL, NULL, 'backup')
     ON CONFLICT (agent, evolution_event_id)
       WHERE direction = 'inbound' AND evolution_event_id IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [row.agent, row.channel, row.identifier, row.author, row.text, row.evolution_event_id],
  );
  return { inserted: rows.length > 0 };
}

// src/whatsapp/group-monitor-reconnect.ts
// Link de reconexão de um "Monitor de grupos A/B", pedido pelo Painel tático.
// O chamador escolhe só o SLOT: instância e telefone esperado saem de
// group_monitors, então o link fica travado no número do monitor e o webhook
// (settleReconnectLinks) desconecta qualquer aparelho diferente que escanear.
import type { Pool } from 'pg';
import { ensureReconnectLink } from './provision-links.js';
import { monitorLabel, type MonitorSlot } from './group-monitors.js';

const LINK_MAX_CLICKS = 10;
const LINK_TTL_DAYS = 7;

export function parseMonitorSlot(raw: unknown): MonitorSlot | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  return s === 'A' || s === 'B' ? s : null;
}

type Ensure = typeof ensureReconnectLink;

/** Reaproveita o link ativo do monitor (o do aviso de queda, se houver): emitir
 *  um novo expiraria o que já chegou no celular. Slot sem linha → null. */
export async function issueMonitorReconnectLink(
  pool: Pool,
  slot: MonitorSlot,
  actor: string | null,
  ensure: Ensure = ensureReconnectLink,
): Promise<{ token: string; expiresAt: string; reused: boolean; label: string } | null> {
  const { rows } = await pool.query(`SELECT slot, instance, phone FROM group_monitors WHERE slot = $1`, [slot]);
  const m = rows[0];
  if (!m) return null;
  const label = monitorLabel(slot);
  const { row, reused } = await ensure(pool, {
    instance: String(m.instance),
    expectedPhone: String(m.phone),
    label,
    workspaceId: null,
    createdBy: actor ?? 'painel-tatico',
    maxClicks: LINK_MAX_CLICKS,
    ttlDays: LINK_TTL_DAYS,
  });
  return { token: row.token, expiresAt: String(row.expiresAt), reused, label };
}

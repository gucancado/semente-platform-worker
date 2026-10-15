import type { Pool } from 'pg';
import type { SystemTarget } from './down-notify-store.js';
import { loadMonitors, monitorLabel, type GroupMonitor } from './group-monitors.js';

/**
 * Alvos do vigia de sistema = env + slots de monitor que NÃO são número de
 * workspace (esses ficam com `sweepDownNumbers`). Mesma instância no env e num
 * slot → um alvo só, com o rótulo do slot e o resto do env preservado.
 */
export function mergeSystemTargets(
  env: SystemTarget[],
  monitors: GroupMonitor[],
  numberInstances: Set<string>,
): SystemTarget[] {
  const out: SystemTarget[] = env.map((t) => ({ ...t }));
  for (const m of monitors) {
    if (numberInstances.has(m.instance)) continue;
    const label = monitorLabel(m.slot);
    const existing = out.find((t) => t.instance === m.instance);
    if (existing) existing.label = label;
    else out.push({ instance: m.instance, expectedPhone: m.phone, label });
  }
  return out;
}

export async function currentSystemTargets(pool: Pool, env: SystemTarget[]): Promise<SystemTarget[]> {
  try {
    const monitors = await loadMonitors(pool);
    const { rows } = await pool.query(
      `SELECT evolution_instance FROM whatsapp_numbers WHERE evolution_instance IS NOT NULL`,
    );
    return mergeSystemTargets(env, monitors, new Set(rows.map((r: any) => String(r.evolution_instance))));
  } catch {
    return env;
  }
}

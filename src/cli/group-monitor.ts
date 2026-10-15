/**
 * Lista/troca os slots "Monitor de grupos A/B" (tabela group_monitors).
 *   pnpm whatsapp:group-monitor list
 *   pnpm whatsapp:group-monitor set --slot=B --instance=<evolution_instance> [--phone=+55...] [--dry-run]
 * Exit 2 = argumento/estado inválido.
 */
import { pool } from '../db.js';
import { config } from '../config.js';
import { MONITOR_AGENT } from '../whatsapp/group-monitors.js';
import { parseGroupMonitorArgs } from '../whatsapp/monitor-cli-args.js';

async function main(): Promise<number> {
  const args = parseGroupMonitorArgs(process.argv.slice(2));
  if ('error' in args) { console.error(args.error); return 2; }

  if (args.cmd === 'list') {
    const { rows } = await pool.query(`SELECT slot, instance, phone, updated_at, updated_by FROM group_monitors ORDER BY slot`);
    if (rows.length === 0) console.log('(nenhum slot configurado)');
    for (const r of rows) console.log(`${r.slot} | ${r.instance} | ${r.phone} | ${new Date(r.updated_at).toISOString()} | ${r.updated_by ?? '-'}`);
    return 0;
  }

  const { slot, instance } = args;
  let numberPhone: string | null = null;
  if (instance !== MONITOR_AGENT) {
    const n = await pool.query(`SELECT phone FROM whatsapp_numbers WHERE evolution_instance = $1 AND removed_at IS NULL`, [instance]);
    if (n.rows.length === 0) { console.error('instância desconhecida (nem saturno nem whatsapp_numbers)'); return 2; }
    numberPhone = n.rows[0].phone ?? null;
  }
  const existing = await pool.query(`SELECT slot, instance, phone FROM group_monitors`);
  const other = existing.rows.find((r: any) => r.slot !== slot && r.instance === instance);
  if (other) { console.error(`a instância ${instance} já é o slot ${other.slot}; um slot por instância`); return 2; }
  const current = existing.rows.find((r: any) => r.slot === slot);
  const phone = args.phone ?? numberPhone ?? (instance === MONITOR_AGENT
    ? (current?.instance === MONITOR_AGENT ? current.phone : null)
      ?? config.SYSTEM_INSTANCE_WATCH_JSON.find((t) => t.instance === MONITOR_AGENT)?.expectedPhone ?? null
    : null);
  if (!phone) { console.error('telefone desconhecido: informe --phone=+55...'); return 2; }

  console.log(`slot ${slot}: ${current ? `${current.instance} (${current.phone})` : '(vazio)'} -> ${instance} (${phone})`);
  if (args.dryRun) { console.log('--dry-run: nada gravado'); return 0; }
  await pool.query(
    `INSERT INTO group_monitors(slot, instance, phone, updated_by) VALUES ($1,$2,$3,'cli')
     ON CONFLICT (slot) DO UPDATE SET instance=EXCLUDED.instance, phone=EXCLUDED.phone, updated_at=now(), updated_by='cli'`,
    [slot, instance, phone],
  );
  console.log('gravado. efeito em até 30s nos processos do worker');
  return 0;
}

main().then(async (c) => { await pool.end(); process.exit(c); }).catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });

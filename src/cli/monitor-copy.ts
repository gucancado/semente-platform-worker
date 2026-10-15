/**
 * Copia para o escopo do monitor (agent='saturno') as mensagens de GRUPO já
 * gravadas pelos números-monitor (slots cuja instância está em whatsapp_numbers).
 *   pnpm whatsapp:monitor-copy --since=<ISO> [--until=<ISO>] [--dry-run]
 * Idempotente (ON CONFLICT DO NOTHING no índice de evento inbound).
 */
import { pool } from '../db.js';
import { MONITOR_AGENT } from '../whatsapp/group-monitors.js';
import { parseMonitorCopyArgs } from '../whatsapp/monitor-cli-args.js';

const SRC = `
  FROM messages m
 WHERE m.whatsapp_number_id = $1
   AND m.created_at >= $2::timestamptz AND ($4::timestamptz IS NULL OR m.created_at < $4::timestamptz)
   AND m.evolution_event_id IS NOT NULL AND m.text IS NOT NULL AND m.kind = 'text'
   AND EXISTS (SELECT 1 FROM whatsapp_groups g WHERE g.agent = '${MONITOR_AGENT}' AND g.jid = m.identifier)`;

const INSERT_SQL = `
INSERT INTO messages (agent, project, channel, identifier, author, direction, text, evolution_event_id,
                      whatsapp_number_id, workspace_id, ingest_source, created_at)
SELECT '${MONITOR_AGENT}', NULL, m.channel, m.identifier, COALESCE(m.author, $3), 'inbound', m.text, m.evolution_event_id,
       NULL, NULL, 'backup', m.created_at
${SRC}
ON CONFLICT (agent, evolution_event_id) WHERE direction = 'inbound' AND evolution_event_id IS NOT NULL DO NOTHING
RETURNING identifier`;

const DRY_SQL = `
SELECT m.identifier, count(*)::int AS n /* $3 referenciado p/ o pg inferir tipos */
${SRC}
   AND $3::text IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.agent='${MONITOR_AGENT}' AND x.direction='inbound' AND x.evolution_event_id = m.evolution_event_id)
 GROUP BY m.identifier ORDER BY n DESC`;

async function main(): Promise<number> {
  const args = parseMonitorCopyArgs(process.argv.slice(2));
  if ('error' in args) { console.error(args.error); return 2; }

  // Leitura direta (sem cache) e só slots apoiados em número de atendimento.
  const { rows: slots } = await pool.query(
    `SELECT gm.slot, gm.instance, gm.phone, wn.id AS number_id
       FROM group_monitors gm
       JOIN whatsapp_numbers wn ON wn.evolution_instance = gm.instance AND wn.removed_at IS NULL
      ORDER BY gm.slot`);
  if (slots.length === 0) { console.log('nenhum slot apoiado em whatsapp_numbers; nada a copiar'); return 0; }

  let total = 0;
  for (const s of slots) {
    console.log(`\nslot ${s.slot} (${s.instance}, número ${s.number_id})${args.dryRun ? ' [dry-run]' : ''}`);
    let perGroup: Array<{ identifier: string; n: number }>;
    if (args.dryRun) {
      perGroup = (await pool.query(DRY_SQL, [s.number_id, args.since, s.phone, args.until])).rows;
    } else {
      const { rows } = await pool.query(INSERT_SQL, [s.number_id, args.since, s.phone, args.until]);
      const m = new Map<string, number>();
      for (const r of rows) m.set(r.identifier, (m.get(r.identifier) ?? 0) + 1);
      perGroup = [...m].map(([identifier, n]) => ({ identifier, n }));
    }
    for (const g of perGroup) { console.log(`  ${g.identifier}: ${g.n}`); total += g.n; }
    if (perGroup.length === 0) console.log('  (nada novo)');
  }
  console.log(`\ntotal ${args.dryRun ? 'a copiar' : 'copiado'}: ${total}`);
  return 0;
}

main().then(async (c) => { await pool.end(); process.exit(c); }).catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });

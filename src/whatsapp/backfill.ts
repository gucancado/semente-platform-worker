import type { Pool } from 'pg';
import type { EvolutionDeps } from '../evolution/client.js';
import { fetchMessages, normalizeGroupJid } from '../evolution/client.js';
import { extractMessageText } from '../webhook/evolution.js';
import { getNumber } from './numbers.js';

export type BackfillResult = { scanned: number; inserted: number; skippedNoText: number; pages: number; reachedCutoff: boolean };

/**
 * Importa mensagens da Evolution p/ `messages`, preservando created_at, com dedup por
 * (whatsapp_number_id, evolution_event_id). Pagina desc e PARA quando messageTimestamp < cutoff.
 * Best-effort: erros por-mensagem logam e seguem.
 */
export async function backfillNumber(
  pool: Pool,
  deps: EvolutionDeps,
  numberId: number,
  opts: { sinceTs: number; maxPages: number; offset?: number; log?: (m: string) => void }
): Promise<BackfillResult> {
  const num = await getNumber(pool, numberId);
  if (!num) return { scanned: 0, inserted: 0, skippedNoText: 0, pages: 0, reachedCutoff: false };
  const offset = opts.offset ?? 100;
  const log = opts.log ?? (() => {});
  let scanned = 0, inserted = 0, skippedNoText = 0, page = 1, reachedCutoff = false;

  for (; page <= opts.maxPages; page++) {
    const { records, pages } = await fetchMessages(deps, num.evolutionInstance, page, offset);
    if (records.length === 0) break;
    for (const m of records) {
      scanned++;
      const ts = Number(m?.messageTimestamp ?? 0);
      if (ts && ts < opts.sinceTs) { reachedCutoff = true; continue; }
      const jid: string | undefined = m?.key?.remoteJid;
      const eventId: string | undefined = m?.key?.id;
      if (!jid || !eventId) continue;
      const text = extractMessageText(m?.message);
      if (!text) { skippedNoText++; continue; }
      const isGroup = jid.endsWith('@g.us');
      const identifier = normalizeGroupJid(jid);
      const author = isGroup && m?.key?.participant ? normalizeGroupJid(m.key.participant) : null;
      const direction = m?.key?.fromMe ? 'outbound' : 'inbound';
      const createdAt = ts ? new Date(ts * 1000) : new Date();
      try {
        const res = await pool.query(
          `INSERT INTO messages (whatsapp_number_id, workspace_id, agent, channel, identifier, author, direction, text, evolution_event_id, created_at)
           VALUES ($1, $2, NULL, 'whatsapp', $3, $4, $5, $6, $7, $8)
           ON CONFLICT (whatsapp_number_id, evolution_event_id)
             WHERE whatsapp_number_id IS NOT NULL AND evolution_event_id IS NOT NULL
             DO NOTHING
           RETURNING id`,
          [numberId, num.workspaceId, identifier, author, direction, text, eventId, createdAt]
        );
        if (res.rows[0]) inserted++;
      } catch (err) {
        log(`[backfill] erro msg ${eventId}: ${(err as Error).message}`);
      }
    }
    if (reachedCutoff) break;
    if (pages && page >= pages) break;
    if (page % 10 === 0) log(`[backfill] number=${numberId} page=${page} scanned=${scanned} inserted=${inserted}`);
  }
  log(`[backfill] DONE number=${numberId} pages=${page} scanned=${scanned} inserted=${inserted} skippedNoText=${skippedNoText} reachedCutoff=${reachedCutoff}`);
  return { scanned, inserted, skippedNoText, pages: page, reachedCutoff };
}

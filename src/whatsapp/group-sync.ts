import type { Pool } from 'pg';
import type { EvolutionDeps } from '../evolution/client.js';
import { fetchAllGroups } from '../evolution/client.js';
import { getNumber } from './numbers.js';
import { upsertParticipants } from './group-participants.js';

/**
 * Busca grupos na Evolution e faz upsert por (whatsapp_number_id, jid).
 * `participants: true` traz o roster na MESMA chamada (custo por grupo = 0).
 *
 * ⚠️ O ON CONFLICT abaixo NÃO pode tocar `linked_workspace_id` — é o vínculo
 * grupo→workspace do cliente (mig 057), preenchido à mão e independente do
 * workspace do número.
 *
 * ⚠️ `participants_synced_at` é o marcador PRÓPRIO do roster — NÃO reusar
 * `updated_at` (esse avança em TODO sync, inclusive os subject-only do
 * on-connect, que não tocam participante nenhum; usá-lo como corte esvaziaria
 * o roster inteiro assim que uma reconexão acontecesse depois do cron). Só
 * avança quando `wantPeople` é true (`CASE WHEN $5 ...`); do contrário a
 * coluna fica INTOCADA (`whatsapp_groups.participants_synced_at` no ELSE do
 * UPDATE).
 *
 * ⚠️ A ORDEM importa: o upsert do grupo grava `participants_synced_at = NOW()`
 * ANTES dos participantes daquele grupo. É isso que faz
 * `last_seen_at >= g.participants_synced_at` (o corte de `listParticipants`)
 * significar "visto neste sync" — inverter a ordem faria o roster inteiro
 * sumir da tela.
 */
export async function syncGroupSubjects(
  pool: Pool,
  deps: EvolutionDeps,
  numberId: number,
  opts?: { participants?: boolean },
): Promise<{ synced: number; participants: number }> {
  const num = await getNumber(pool, numberId);
  if (!num) return { synced: 0, participants: 0 };
  const wantPeople = opts?.participants === true;
  const groups = await fetchAllGroups(deps, num.evolutionInstance, { participants: wantPeople });
  let synced = 0;
  let participants = 0;
  for (const g of groups) {
    if (!g.subject) continue;
    const { rows } = await pool.query(
      `INSERT INTO whatsapp_groups (jid, subject, whatsapp_number_id, workspace_id, updated_at, participants_synced_at)
       VALUES ($1, $2, $3, $4, NOW(), CASE WHEN $5 THEN NOW() ELSE NULL END)
       ON CONFLICT (whatsapp_number_id, jid) WHERE whatsapp_number_id IS NOT NULL
       DO UPDATE SET subject = EXCLUDED.subject, workspace_id = EXCLUDED.workspace_id, updated_at = NOW(),
         participants_synced_at = CASE WHEN $5 THEN NOW() ELSE whatsapp_groups.participants_synced_at END
       RETURNING id`,
      [g.jid, g.subject, numberId, num.workspaceId, wantPeople],
    );
    synced++;
    const groupId = rows[0] ? Number(rows[0].id) : null;
    if (groupId && g.participants?.length) {
      // Best-effort: falha no roster não derruba o sync de subjects.
      try {
        participants += await upsertParticipants(
          pool, groupId,
          g.participants.map((p) => ({ phone: p.phone, pushName: null, isAdmin: p.isAdmin, isLid: p.isLid })),
        );
      } catch { /* segue */ }
    }
  }
  return { synced, participants };
}

/**
 * ⚠️ CAMINHO QUENTE DO ATENDIMENTO. Quem chama isto é o on-connect de TODO
 * número de TODO cliente (`src/whatsapp/connection-events.ts`), não a feature de
 * grupos. O default de `participants` é `false` e **tem que continuar sendo**:
 * ligá-lo aqui faria cada reconexão de cada número disparar a chamada mais cara
 * da Evolution, em contas que não têm vínculo nenhum. Só o cron novo e a rota
 * admin manual pedem `participants: true`.
 */
export async function syncGroupSubjectsDebounced(
  pool: Pool,
  deps: EvolutionDeps,
  numberId: number,
  minMinutes = 30,
  opts?: { participants?: boolean },
): Promise<void> {
  const { rows } = await pool.query<{ recent: boolean }>(
    `SELECT EXISTS(
        SELECT 1 FROM whatsapp_groups
         WHERE whatsapp_number_id = $1 AND updated_at > NOW() - ($2 || ' minutes')::interval
      ) AS recent`,
    [numberId, String(minMinutes)],
  );
  if (rows[0]?.recent) return;
  await syncGroupSubjects(pool, deps, numberId, opts);
}

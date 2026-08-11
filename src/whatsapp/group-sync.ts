import type { Pool } from 'pg';
import type { EvolutionDeps } from '../evolution/client.js';
import { fetchAllGroups } from '../evolution/client.js';
import { getNumber } from './numbers.js';
import { upsertParticipants } from './group-participants.js';

/**
 * Busca grupos na Evolution e faz upsert por (whatsapp_number_id, jid).
 * `participants: true` traz o roster de TODOS os grupos do número na MESMA
 * chamada (custo HTTP fixo, só uma request) — mas a PERSISTÊNCIA do roster é
 * restrita a `opts.participantScope`, quando informado.
 *
 * ⚠️ Escopo LGPD (`participantScope`): em produção um número tem ~140 grupos,
 * a imensa maioria alheia à feature de vínculo grupo→workspace. Gravar o
 * roster de todos eles coletaria e armazenaria telefone de gente em grupos
 * fora do escopo da feature, multiplicando o custo de banco à toa (o upsert é
 * uma query por pessoa). `runGroupSyncCycle` (group-sync-cron.ts) monta o
 * conjunto de jids VINCULADOS daquele número e passa aqui; sem o opt (ex.: o
 * on-connect nem chega a pedir participants), nada muda. Grupo fora do escopo
 * ainda tem o SUBJECT upsertado normalmente — só o roster não é gravado.
 *
 * ⚠️ O ON CONFLICT abaixo NÃO pode tocar `linked_workspace_id` — é o vínculo
 * grupo→workspace do cliente (mig 057), preenchido à mão e independente do
 * workspace do número.
 *
 * ⚠️ `participants_synced_at` é o marcador PRÓPRIO do roster — NÃO reusar
 * `updated_at` (esse avança em TODO sync, inclusive os subject-only do
 * on-connect, que não tocam participante nenhum; usá-lo como corte esvaziaria
 * o roster inteiro assim que uma reconexão acontecesse depois do cron).
 *
 * ⚠️ O marcador só avança quando o roster daquele grupo foi de fato
 * PERSISTIDO (≥1 participante gravado) — não quando `wantPeople` é true. A
 * Evolution pode devolver `participants` vazio/ausente para um grupo (e o
 * upsert é best-effort, dentro de um catch), e nesse caso `upsertParticipants`
 * nunca roda: se o marcador avançasse mesmo assim, `listParticipants` (que
 * corta por `last_seen_at >= participants_synced_at`) devolveria lista VAZIA
 * até o próximo sync bom, sem motivo aparente na tela. Por isso o UPDATE do
 * marcador é uma query SEPARADA, disparada só depois de confirmar que
 * `upsertParticipants` gravou ≥1 linha — nunca embutida no upsert do grupo.
 *
 * ⚠️ A ORDEM importa: os participantes são gravados (com o próprio `NOW()` de
 * cada statement) ANTES do UPDATE que carimba `participants_synced_at`. É
 * isso que garante `last_seen_at >= g.participants_synced_at` (o corte de
 * `listParticipants`) — inverter a ordem poderia carimbar o marcador com um
 * instante posterior a algum `last_seen_at` e esvaziar o roster na leitura.
 */
export async function syncGroupSubjects(
  pool: Pool,
  deps: EvolutionDeps,
  numberId: number,
  opts?: { participants?: boolean; participantScope?: Set<string> },
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
      `INSERT INTO whatsapp_groups (jid, subject, whatsapp_number_id, workspace_id, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (whatsapp_number_id, jid) WHERE whatsapp_number_id IS NOT NULL
       DO UPDATE SET subject = EXCLUDED.subject, workspace_id = EXCLUDED.workspace_id, updated_at = NOW()
       RETURNING id`,
      [g.jid, g.subject, numberId, num.workspaceId],
    );
    synced++;
    const groupId = rows[0] ? Number(rows[0].id) : null;
    const inScope = !opts?.participantScope || opts.participantScope.has(g.jid);
    if (groupId && wantPeople && inScope && g.participants?.length) {
      // Best-effort: falha no roster não derruba o sync de subjects.
      let stored = 0;
      try {
        stored = await upsertParticipants(
          pool, groupId,
          g.participants.map((p) => ({ phone: p.phone, pushName: null, isAdmin: p.isAdmin, isLid: p.isLid })),
        );
      } catch { /* segue */ }
      if (stored > 0) {
        // Marcador avança SÓ aqui — depois de confirmar que o roster foi
        // gravado de fato. Ver bloco de comentário acima.
        await pool.query(`UPDATE whatsapp_groups SET participants_synced_at = NOW() WHERE id = $1`, [groupId]);
        participants += stored;
      }
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

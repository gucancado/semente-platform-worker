import type { Pool } from 'pg';
import type { EvolutionDeps } from '../evolution/client.js';
import { fetchGroupParticipants } from '../evolution/client.js';
import { upsertParticipants } from './group-participants.js';

export type AgentGroupSyncResult = {
  groupsAttempted: number;
  groupsSynced: number;
  participants: number;
  failed: number;
};

/**
 * Sincroniza o roster de participantes dos grupos VINCULADOS escopo 'agent' —
 * as linhas legadas de `whatsapp_groups` (`whatsapp_number_id IS NULL`, hoje
 * só `agent='saturno'`, o número da ORGANIZAÇÃO). É exatamente o escopo onde
 * o roster faltava até aqui (`group-sync.ts`/`group-sync-cron.ts` só cobrem
 * grupos escopados por NÚMERO) — e onde é mais necessário: as menções
 * `@<numero>` nas mensagens usam o LID de privacidade, e só o payload de
 * participantes da Evolution mapeia LID→telefone.
 *
 * A instância Evolution usada pra buscar o roster tem o MESMO nome do agent
 * (medido em produção: a instância `saturno` está viva e responde). Por isso
 * `fetchGroupParticipants(deps, agent, jid)` — não há `whatsapp_numbers` pra
 * resolver aqui, ao contrário do escopo 'number'.
 *
 * Não há como pedir o roster de TODOS os grupos do agent numa chamada só (o
 * `fetchAllGroups?getParticipants=true` que o escopo 'number' usa exige uma
 * instância dedicada a um único conjunto de grupos — aqui a instância serve
 * a ORGANIZAÇÃO inteira, e só o endpoint `/group/participants/{instance}`
 * aceita um `groupJid` específico). Por isso o loop é por grupo, best-effort:
 * falha num grupo (Evolution fora do ar pra aquele jid, 500, timeout) não
 * derruba a sincronização dos outros.
 *
 * ⚠️ MESMA invariante de `syncGroupSubjects` (group-sync.ts): roster e
 * marcador (`participants_synced_at`) usam UM ÚNICO timestamp (`syncedAt`,
 * capturado uma vez por grupo — não por chamada, já que aqui cada grupo é
 * uma requisição HTTP separada), e o marcador só avança quando
 * `upsertParticipants` de fato GRAVOU ≥1 linha. Sem essa igualdade,
 * `listParticipants` (corte `last_seen_at >= participants_synced_at`)
 * devolveria lista vazia pro grupo inteiro assim que os dois `NOW()`
 * divergissem — ver o comentário longo em `group-sync.ts` pra o histórico
 * completo do bug que essa invariante corrige.
 */
export async function syncAgentGroupParticipants(
  pool: Pool,
  deps: EvolutionDeps,
  agent: string,
): Promise<AgentGroupSyncResult> {
  const { rows } = await pool.query(
    `SELECT id, jid
       FROM whatsapp_groups
      WHERE linked_workspace_id IS NOT NULL AND whatsapp_number_id IS NULL AND agent = $1`,
    [agent],
  );
  const out: AgentGroupSyncResult = { groupsAttempted: rows.length, groupsSynced: 0, participants: 0, failed: 0 };
  for (const g of rows) {
    const groupId = Number(g.id);
    const jid = g.jid as string;
    try {
      const participants = await fetchGroupParticipants(deps, agent, jid);
      if (participants.length === 0) continue;
      // Capturado por grupo — cada grupo é uma chamada HTTP separada, então
      // não dá pra reusar um `syncedAt` só pra todos (ver comentário acima).
      const syncedAt = new Date();
      const stored = await upsertParticipants(
        pool, groupId,
        participants.map((p) => ({ phone: p.phone, pushName: p.pushName, isAdmin: p.isAdmin, isLid: p.isLid, lid: p.lid })),
        syncedAt,
      );
      if (stored > 0) {
        // Marcador só avança DEPOIS de confirmar que o roster foi gravado —
        // mesma regra de `syncGroupSubjects`.
        await pool.query(`UPDATE whatsapp_groups SET participants_synced_at = $2 WHERE id = $1`, [groupId, syncedAt]);
        out.groupsSynced++;
        out.participants += stored;
      }
    } catch {
      // Um grupo com problema não pode derrubar o sync dos outros.
      out.failed++;
    }
  }
  return out;
}

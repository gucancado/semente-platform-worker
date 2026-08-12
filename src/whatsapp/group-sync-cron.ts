import type { Pool } from 'pg';
import type { EvolutionDeps } from '../evolution/client.js';
import { syncGroupSubjects } from './group-sync.js';
import { syncAgentGroupParticipants } from './agent-group-sync.js';
import { sweepGroupAvatars } from './group-avatars.js';
import { resolveGroupIdentities } from './group-identity.js';
import { getNumber } from './numbers.js';
import { localTimeInSaoPaulo } from '../lua/scheduler.js';

/**
 * Ciclo diário de manutenção dos grupos VINCULADOS: subjects + roster de
 * participantes, depois fotos (com orçamento) e identidades — nos DOIS
 * escopos possíveis (`number` e o legado `agent`, ver `group-links.ts`).
 *
 * Só toca números/agents que têm PELO MENOS UM grupo vinculado: sem vínculo,
 * nada aqui tem consumidor, e `fetchAllGroups?getParticipants=true` é a
 * chamada mais cara que fazemos à Evolution (o `groupFetchAllParticipating`
 * do Baileys sobre ~140 grupos) — não pode rodar "por via das dúvidas".
 *
 * ⚠️ LGPD/escopo: a chamada à Evolution devolve o roster de TODOS os grupos do
 * número numa tacada só (não dá pra pedir só os vinculados), mas a
 * PERSISTÊNCIA do roster (o que `syncGroupSubjects` grava em
 * `whatsapp_group_participants`) é restrita aos jids vinculados DAQUELE
 * número — por isso a query abaixo traz `(numberId, jid)` em vez de só
 * `DISTINCT numberId`, e monta um `Set<jid>` por número (`participantScope`).
 * Sem essa restrição o worker coletaria e armazenaria telefone de gente em
 * ~140 grupos alheios à feature, e multiplicaria à toa o custo do upsert
 * (uma query por pessoa). O escopo 'agent' não tem esse problema: cada grupo
 * é buscado individualmente por jid (`fetchGroupParticipants`, ver
 * `agent-group-sync.ts`), então a restrição já vem do próprio SELECT.
 */
export async function runGroupSyncCycle(
  pool: Pool, deps: EvolutionDeps, budgets: { avatars: number; identities: number },
  log: { info: Function; error: Function },
): Promise<void> {
  // `whatsapp_number_id IS NOT NULL` já EXCLUI as linhas de escopo 'agent'
  // (grupo da organização, hoje só 'saturno' — ver group-links.ts). Esse
  // escopo segue um caminho SEPARADO logo abaixo (`syncAgentGroupParticipants`)
  // porque não tem `whatsapp_numbers`/instância pra resolver aqui — a
  // instância Evolution do agent é o PRÓPRIO nome do agent.
  const { rows } = await pool.query(
    `SELECT whatsapp_number_id AS id, jid
       FROM whatsapp_groups
      WHERE linked_workspace_id IS NOT NULL AND whatsapp_number_id IS NOT NULL`,
  );
  const linkedJidsByNumber = new Map<number, Set<string>>();
  for (const r of rows) {
    const numberId = Number(r.id);
    if (!linkedJidsByNumber.has(numberId)) linkedJidsByNumber.set(numberId, new Set());
    linkedJidsByNumber.get(numberId)!.add(r.jid as string);
  }
  for (const [numberId, linkedJids] of linkedJidsByNumber) {
    const num = await getNumber(pool, numberId);
    if (!num) continue;
    try {
      const synced = await syncGroupSubjects(pool, deps, numberId, { participants: true, participantScope: linkedJids });
      const avatars = await sweepGroupAvatars(pool, deps, num.evolutionInstance, budgets.avatars);
      const ids = await resolveGroupIdentities(pool, budgets.identities);
      log.info({ numberId, synced, avatars, ids }, 'group-sync: ciclo concluído');
    } catch (err) {
      // Um número com problema não pode derrubar o ciclo dos outros.
      log.error({ numberId, err }, 'group-sync: ciclo falhou');
    }
  }

  // Escopo 'agent': linhas legadas sem número (hoje só o agent 'saturno', o
  // número da ORGANIZAÇÃO). Não há subject pra sincronizar aqui (esse escopo
  // não tem `fetchAllGroups` — os subjects vêm do import manual admin, ver
  // `group-agent-messages.ts`), só roster + avatares. `resolveGroupIdentities`
  // acima já cobre os participantes recém-gravados (não é escopado por
  // número/agent — roda sobre `whatsapp_group_participants` inteira).
  const { rows: agentRows } = await pool.query(
    `SELECT DISTINCT agent
       FROM whatsapp_groups
      WHERE linked_workspace_id IS NOT NULL AND whatsapp_number_id IS NULL AND agent IS NOT NULL`,
  );
  for (const r of agentRows) {
    const agent = r.agent as string;
    try {
      // A instância Evolution do escopo 'agent' TEM o mesmo nome do agent
      // (medido em produção: instância 'saturno' viva) — reusada tanto pro
      // fetch de roster (dentro de syncAgentGroupParticipants) quanto pro
      // sweep de avatares, que é global por telefone (ver group-avatars.ts).
      const synced = await syncAgentGroupParticipants(pool, deps, agent);
      const avatars = await sweepGroupAvatars(pool, deps, agent, budgets.avatars);
      log.info({ agent, synced, avatars }, 'group-sync: ciclo agent concluído');
    } catch (err) {
      // Um agent com problema não pode derrubar o ciclo dos outros.
      log.error({ agent, err }, 'group-sync: ciclo agent falhou');
    }
  }
}

/**
 * Tick de 60s + janela horária em São Paulo + guard de sobreposição + CLAIM POR DATA.
 *
 * Padrão canônico do repo: `src/integrations/fireflies/import-cron.ts` (que por
 * sua vez espelha `src/lua/scheduler.ts`) — reusar `localTimeInSaoPaulo()` de
 * `../lua/scheduler.js`, NÃO duplicar aritmética de fuso (o container roda em
 * UTC; a hora do processo não serve).
 *
 * Por que não `setInterval` de 24h, como faz o provisioning-reaper: um intervalo
 * longo não roda "às 04:30" — roda 24h depois do boot e deriva a cada deploy.
 * E uma janela horária SEM claim dispara um ciclo por minuto enquanto a hora
 * casar.
 *
 * ⚠️ HORA: 04:30, não 04:00. `FIREFLIES_IMPORT_HOUR` tem default 4
 * (`src/config.ts`) e o import roda NO MESMO event loop — 04:00 colocaria os
 * dois concorrentes juntos. (A folga do BCD, que coleta às 03:00, é outra
 * máquina e não era o conflito real.)
 *
 * ⚠️ SHAPE de `localTimeInSaoPaulo`: o tipo `LocalTime` (`src/lua/scheduler.ts`)
 * só tinha `{ hour, isoWeekday, date }` — sem minuto. O formatter interno já
 * pedia `minute: '2-digit'` ao `Intl.DateTimeFormat` mas não extraía o campo;
 * extraí-lo ali (mudança aditiva, não quebra Lua nem o import do Fireflies) foi
 * o jeito de ter precisão de 04:30 sem duplicar a aritmética de fuso aqui.
 *
 * O claim em memória basta aqui: um restart dentro da janela pode repetir o
 * ciclo, e todas as operações são idempotentes (upsert, sweep com orçamento,
 * resolução carimbada). Se um dia isso passar a doer, o padrão do
 * `import-cron.ts` é claim persistido via `INSERT … ON CONFLICT DO NOTHING`.
 */
export function startGroupSyncCron(
  log: { info: Function; error: Function },
  deps: { pool: Pool; evolution: EvolutionDeps; avatarBudget: number; identityBudget: number },
): void {
  let running = false;
  let lastRunDay: string | null = null;
  const tick = async () => {
    const local = localTimeInSaoPaulo(new Date());
    if (local.hour !== 4 || local.minute < 30) return;
    if (lastRunDay === local.date) return;   // já rodou hoje
    if (running) return;
    running = true;
    lastRunDay = local.date;                 // claim ANTES de rodar (ciclo demorado não re-entra)
    try {
      await runGroupSyncCycle(deps.pool, deps.evolution, { avatars: deps.avatarBudget, identities: deps.identityBudget }, log);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, 60_000);
  (handle as { unref?: () => void }).unref?.();
}

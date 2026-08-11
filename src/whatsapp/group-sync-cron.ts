import type { Pool } from 'pg';
import type { EvolutionDeps } from '../evolution/client.js';
import { syncGroupSubjects } from './group-sync.js';
import { sweepGroupAvatars } from './group-avatars.js';
import { resolveGroupIdentities } from './group-identity.js';
import { getNumber } from './numbers.js';
import { localTimeInSaoPaulo } from '../lua/scheduler.js';

/**
 * Ciclo diário de manutenção dos grupos VINCULADOS: subjects + roster de
 * participantes, depois fotos (com orçamento) e identidades.
 *
 * Só toca números que têm PELO MENOS UM grupo vinculado: sem vínculo, nada aqui
 * tem consumidor, e `fetchAllGroups?getParticipants=true` é a chamada mais cara
 * que fazemos à Evolution (o `groupFetchAllParticipating` do Baileys sobre ~140
 * grupos) — não pode rodar "por via das dúvidas".
 *
 * ⚠️ LGPD/escopo: a chamada à Evolution devolve o roster de TODOS os grupos do
 * número numa tacada só (não dá pra pedir só os vinculados), mas a
 * PERSISTÊNCIA do roster (o que `syncGroupSubjects` grava em
 * `whatsapp_group_participants`) é restrita aos jids vinculados DAQUELE
 * número — por isso a query abaixo traz `(numberId, jid)` em vez de só
 * `DISTINCT numberId`, e monta um `Set<jid>` por número (`participantScope`).
 * Sem essa restrição o worker coletaria e armazenaria telefone de gente em
 * ~140 grupos alheios à feature, e multiplicaria à toa o custo do upsert
 * (uma query por pessoa).
 */
export async function runGroupSyncCycle(
  pool: Pool, deps: EvolutionDeps, budgets: { avatars: number; identities: number },
  log: { info: Function; error: Function },
): Promise<void> {
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

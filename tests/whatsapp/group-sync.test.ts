/**
 * tests/whatsapp/group-sync.test.ts — DB-free (fake pool + fetch mock).
 *
 * Cobre o bug do fix round 1: `syncGroupSubjects` só pode avançar
 * `participants_synced_at` (e gravar roster) quando `opts.participants` é
 * `true`. A chamada sem esse opt — o caminho quente do on-connect
 * (`syncGroupSubjectsDebounced`) — tem que deixar o marcador e o roster
 * intocados, senão `listParticipants` esvazia o roster inteiro assim que uma
 * reconexão qualquer acontece depois do cron de participantes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncGroupSubjects } from '../../src/whatsapp/group-sync.js';

const NUMBER_ROW = {
  id: 3, workspace_id: 'ws-saturno', phone: '+553100000000', evolution_instance: 'saturno-inst',
  label: null, status: 'connected', mode: 'monitored', expose_groups_in_mcp: false,
  created_by: null, created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-01T00:00:00Z'),
  removed_at: null,
};

const RAW_PARTICIPANTS = [{ id: '5531999998888@s.whatsapp.net', admin: 'admin' }];

/** Evolution devolve o roster só quando a URL pede `getParticipants=true`. */
function makeEvolutionDeps() {
  return {
    baseUrl: 'https://evo', apiKey: 'k',
    fetch: (async (url: string) => {
      const withPeople = /getParticipants=true/.test(url);
      return {
        ok: true, status: 200,
        json: async () => ([{
          id: '120363001@g.us', subject: 'Grupo Teste',
          ...(withPeople ? { participants: RAW_PARTICIPANTS } : {}),
        }]),
      } as any;
    }) as any,
  };
}

function makePool() {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('whatsapp_group_participants')) return { rows: [] };
      if (sql.includes('whatsapp_numbers')) return { rows: [NUMBER_ROW] };
      if (sql.includes('whatsapp_groups')) return { rows: [{ id: 7 }] }; // RETURNING id do upsert
      throw new Error(`query inesperada: ${sql}`);
    },
  } as any;
  return { pool, calls };
}

test('syncGroupSubjects: só a chamada com participants:true avança participants_synced_at e grava o roster', async () => {
  const { pool, calls } = makePool();
  const deps = makeEvolutionDeps();

  // 1ª chamada — cron/rota admin manual, pede o roster.
  const first = await syncGroupSubjects(pool, deps, 3, { participants: true });
  assert.equal(first.synced, 1);
  assert.equal(first.participants, 1, '1ª chamada grava o participante do roster');

  const groupUpsert1 = calls.filter((c) => c.sql.includes('whatsapp_groups') && !c.sql.includes('whatsapp_group_participants'));
  assert.equal(groupUpsert1.length, 1);
  assert.equal(groupUpsert1[0]!.params[4], true, '1ª chamada: wantPeople=true no upsert do grupo (avança participants_synced_at)');

  const participantInserts1 = calls.filter((c) => c.sql.includes('whatsapp_group_participants'));
  assert.equal(participantInserts1.length, 1, '1ª chamada grava 1 participante');

  calls.length = 0; // isola a 2ª chamada

  // 2ª chamada — on-connect (debounce), SEM participants: é o caminho quente,
  // não pode herdar `participants: true` (custo mais caro da Evolution).
  const second = await syncGroupSubjects(pool, deps, 3);
  assert.equal(second.synced, 1);
  assert.equal(second.participants, 0, '2ª chamada NÃO grava participante nenhum — é o bug corrigido');

  const groupUpsert2 = calls.filter((c) => c.sql.includes('whatsapp_groups') && !c.sql.includes('whatsapp_group_participants'));
  assert.equal(groupUpsert2.length, 1);
  assert.equal(
    groupUpsert2[0]!.params[4], false,
    '2ª chamada: wantPeople=false → participants_synced_at fica INTOCADO (CASE WHEN $5 ... ELSE whatsapp_groups.participants_synced_at)',
  );

  const participantInserts2 = calls.filter((c) => c.sql.includes('whatsapp_group_participants'));
  assert.equal(participantInserts2.length, 0, '2ª chamada não deve tocar whatsapp_group_participants');
});
